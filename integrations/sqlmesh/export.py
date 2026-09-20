"""Export SQLMesh source metadata for ERD Studio; never plan, apply, run or audit.

Loading a SQLMesh project executes its configuration/macros. Run only for trusted
projects, using their own Python environment. No credentials enter the artifact.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import tempfile


def input_files(root: Path, semantic: Path) -> list[Path]:
    files = set()
    for name in ("config.py", "config.yaml", "config.yml", "external_models.yaml", "schema.yaml"):
        file = root / name
        if file.is_file():
            files.add(file)
    for directory in ("models", "macros", "audits", "seeds", "external_models"):
        for file in (root / directory).rglob("*"):
            if (file.is_file() and file.suffix in (".sql", ".py", ".yaml", ".yml", ".csv")
                    and not any(part.startswith(".") for part in file.relative_to(root / directory).parts[:-1])):
                files.add(file)
    binding_file = semantic / "sqlmesh-bindings.json"
    if binding_file.exists():
        files.add(binding_file)
    return sorted(files)


def hashes(root: Path, semantic: Path) -> dict[str, str]:
    return {str(p.relative_to(root).as_posix()): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in input_files(root, semantic)}


class InspectionUnavailable(ValueError):
    """A credential-free reason suitable for a saved diagnostic."""


def identifier_folding(dialect: str) -> str:
    """How the dialect folds unquoted identifiers: the key ERD Studio matches logical names by.

    Logical designs spell columns lowercase; engines report them folded. Without this
    a Snowflake project compares `customer_id` against `CUSTOMER_ID` and matches nothing.
    """
    from sqlglot.dialects.dialect import Dialect

    try:
        strategy = Dialect.get_or_raise(dialect).NORMALIZATION_STRATEGY.name
    except (ValueError, AttributeError):
        # An unknown dialect gets the conservative choice: match spelling exactly.
        return "exact"
    if strategy in ("LOWERCASE", "CASE_INSENSITIVE"):
        return "lower"
    if strategy in ("UPPERCASE", "CASE_INSENSITIVE_UPPERCASE"):
        return "upper"
    return "exact"


def readonly_duckdb_adapter(connection, root: Path):
    """Bypass connection initialization SQL/extensions; enforce read-only in DuckDB itself."""
    import duckdb
    from sqlmesh.core.engine_adapter.duckdb import DuckDBEngineAdapter

    if (connection.type_ != "duckdb" or connection.catalogs or connection.extensions
            or connection.secrets or connection.filesystems or connection.connector_config):
        raise InspectionUnavailable("Warehouse inspection currently supports plain local DuckDB files only (no attachments, extensions or connection hooks)")
    database = connection.database
    if not database or database == ":memory:" or "://" in database or database.startswith("md:"):
        raise InspectionUnavailable("Warehouse inspection requires a persistent local DuckDB database")
    file = (root / database).resolve()
    # A lazy read-only connection cannot create a missing database, even on failure.
    return DuckDBEngineAdapter(lambda: duckdb.connect(str(file), read_only=True),
                               default_catalog=file.stem), file.stem


def prepare_inspection(context, root: Path):
    """Load source models without opening SQLMesh's normal read/write connections."""
    if len(context.configs) != 1 or len(context.config.gateways) != 1:
        raise InspectionUnavailable("Warehouse inspection currently supports single-project, single-gateway DuckDB projects")
    if context.config.get_scheduler(context.gateway).type_ != "builtin":
        raise InspectionUnavailable("Warehouse inspection currently requires SQLMesh's built-in scheduler state")
    adapter, catalog = readonly_duckdb_adapter(context.connection_config, root)
    context._engine_adapter = adapter
    # Avoid SQLMesh's catalog discovery opening connections or initializing state.
    context.__dict__["engine_adapters"] = {context.selected_gateway: adapter}
    context.__dict__["default_catalog_per_gateway"] = {context.selected_gateway: catalog}


def inspect_warehouse(context, root: Path, environment: str, models: list[dict]) -> dict:
    from sqlmesh.core.state_sync import EngineAdapterStateSync
    from sqlmesh.core.environment import Environment
    from sqlmesh.utils.date import now_timestamp

    environment = Environment.sanitize_name(environment)
    result = {"environment": environment, "observedAt": datetime.now(timezone.utc).isoformat(),
              "models": []}
    state_adapter = None
    try:
        connection = context.config.get_state_connection(context.gateway) or context.connection_config
        state_adapter, _ = readonly_duckdb_adapter(connection, root)
        # Do NOT call context.state_reader/table_name: lazy state initialization can migrate.
        state = EngineAdapterStateSync(state_adapter, schema=context.config.get_state_schema(context.gateway),
                                      cache_dir=context.cache_dir)
        if state.get_versions(validate=False).schema_version == 0:
            raise InspectionUnavailable("No readable SQLMesh state; deploy the project separately before inspecting")
        state.get_versions()  # Fail on incompatible state; never migrate it.
        env = state.get_environment(environment)
        if env is None:
            # A typo in the environment setting must not read as "nothing is deployed".
            raise InspectionUnavailable(f"Environment '{environment}' was not found in SQLMesh state; "
                                        "check erdStudio.sqlmesh.environment or deploy that environment first")
        if not env.finalized_ts or (env.expiration_ts and env.expiration_ts <= now_timestamp()):
            raise InspectionUnavailable("Environment is expired or its deployment is not finalized; retry after deployment")
        promoted = {s.name: s for s in env.promoted_snapshots}
        for model in models:
            observation = {"id": model["id"], "status": "not-deployed", "relation": None, "columns": []}
            snapshot = promoted.get(model["id"])
            if model["kind"] in ("EMBEDDED", "EXTERNAL"):
                observation.update(status="unsupported", diagnostic="Model has no managed environment relation")
            elif snapshot:
                table = snapshot.qualified_view_name.table_for_environment(env.naming_info, dialect="duckdb")
                observation["relation"] = table.sql(dialect="duckdb", identify=True)
                try:
                    columns = context.engine_adapter.columns(table)
                    observation.update(status="observed", columns=[
                        {"name": name, "dataType": dtype.sql(dialect="duckdb"), "description": ""}
                        for name, dtype in columns.items()])
                except Exception:
                    # A permission/lock/query error is not evidence that a column was removed.
                    observation.update(status="unavailable", diagnostic="Relation metadata could not be read (missing relation, permissions, lock or unsupported view)")
            result["models"].append(observation)
    except Exception as error:
        # Avoid persisting connection strings, credentials or raw driver errors in artifacts.
        diagnostic = str(error) if isinstance(error, InspectionUnavailable) else "Warehouse/state metadata unavailable (database lock, missing file, permissions or incompatible SQLMesh state)"
        # The whole inspection failed, so the reason is stated once at the top
        # level (where the canvas notice shows it) as well as on every model.
        result["diagnostic"] = diagnostic
        result["models"] = [{"id": m["id"], "status": "unavailable", "relation": None,
                             "columns": [], "diagnostic": diagnostic} for m in models]
    finally:
        if state_adapter:
            state_adapter.close()
    return result


def export_project(root: Path, semantic: Path, gateway: str | None, config: str | None,
                   environment: str | None = None) -> dict:
    from sqlmesh.core.context import Context
    from sqlmesh.core.dialect import normalize_model_name
    from sqlglot import exp
    from sqlglot.optimizer.normalize_identifiers import normalize_identifiers

    before = hashes(root, semantic)
    context = Context(paths=str(root), gateway=gateway, config=config, load=False, load_state=False)
    diagnostics: list[str] = []
    try:
        if environment is not None:
            prepare_inspection(context, root)
        context.load()
        bindings_file = semantic / "sqlmesh-bindings.json"
        bindings = json.loads(bindings_file.read_text()) if bindings_file.exists() else {"version": 1, "models": {}}
        if bindings.get("version") != 1 or not isinstance(bindings.get("models"), dict):
            raise ValueError("sqlmesh-bindings.json must contain version: 1 and a models object")
        aliases = {}
        used = set()
        for alias, model_id in bindings["models"].items():
            if not re.fullmatch(r"[a-z][a-z0-9_]*", alias) or not isinstance(model_id, str):
                raise ValueError(f"Invalid binding: {alias}")
            model = context.get_model(model_id)
            if model is None:
                diagnostics.append(f"Binding {alias} points to an unavailable model: {model_id}")
                used.add(alias)
                continue
            if model.fqn in aliases:
                raise ValueError(f"Multiple aliases for model {model.fqn}")
            aliases[model.fqn] = alias
            used.add(alias)
        for model_id, model in sorted(context.models.items()):
            if model_id not in aliases:
                stem = re.sub(r"[^a-z0-9_]+", "_", f"{model.schema_name}_{model.view_name}".lower()).strip("_")
                if not stem or not stem[0].isalpha():
                    stem = "model_" + stem
                alias = f"{stem}_{hashlib.sha256(model_id.encode()).hexdigest()[:10]}"
                if alias in used:
                    raise ValueError(f"Alias collision for {model_id}; add an explicit binding")
                aliases[model_id] = alias
                used.add(alias)

        models = []
        relationships = []
        for model_id, model in sorted(context.models.items()):
            types = model.columns_to_types
            descriptions = model.column_descriptions
            source = getattr(model, "_path", None)
            source_path = None
            if source:
                try:
                    source_path = Path(source).resolve().relative_to(root).as_posix()
                except ValueError:
                    diagnostics.append(f"Source outside project for {model_id}; navigation unavailable")
            keys = []
            for audit_name, kwargs in model.audits:
                # Filtered uniqueness is not a claim about the complete relation.
                condition = kwargs.get("condition")
                if condition is not None and not isinstance(condition, exp.Boolean):
                    diagnostics.append(f"Conditional audit {audit_name} on {model_id} not used for cardinality")
                    continue
                if condition is not None and not condition.this:
                    continue
                if audit_name in ("unique_values", "unique_combination_of_columns"):
                    columns = kwargs.get("columns")
                    if isinstance(columns, exp.Paren):
                        columns = columns.unnest()
                    expressions = list(columns.expressions) if isinstance(columns, (exp.Tuple, exp.Array)) else [columns]
                    if expressions and all(isinstance(c, exp.Column) for c in expressions):
                        names = [normalize_identifiers(c.copy(), dialect=model.dialect).name for c in expressions]
                        keys.extend([[name] for name in names] if audit_name == "unique_values" else [names])
                    else:
                        diagnostics.append(f"Unresolved uniqueness arguments on {model_id}")
                elif audit_name == "erd_relationship":
                    child, parent, to = kwargs.get("column"), kwargs.get("field"), kwargs.get("to")
                    if isinstance(child, exp.Column) and isinstance(parent, exp.Column) and isinstance(to, (exp.Table, exp.Column)):
                        target = normalize_model_name(to.sql(dialect=model.dialect), default_catalog=model.default_catalog, dialect=model.dialect)
                        if target in aliases:
                            relationships.append({"fromId": model_id,
                                                  "fromColumn": normalize_identifiers(child.copy(), dialect=model.dialect).name,
                                                  "toId": target,
                                                  "toColumn": normalize_identifiers(parent.copy(), dialect=model.dialect).name,
                                                  "audit": audit_name})
                            # SQLMesh builds the DAG from the query, not from audits. An audit whose
                            # parent is not a dependency is rendered against the parent's virtual
                            # name and can run before that table exists (a fresh deployment fails)
                            # or against prod's view from a dev environment. The edge is still the
                            # declared intent; the deployment hazard is reported alongside it.
                            if target not in model.depends_on:
                                diagnostics.append(f"erd_relationship on {model_id} targets {target}, which is not a dependency of the model; "
                                                   f"add depends_on ({to.sql(dialect=model.dialect)}) to the MODEL so the audit resolves "
                                                   "to the environment's own table and runs after it exists")
                        else:
                            diagnostics.append(f"Unresolved relationship target {target} on {model_id}")
                    else:
                        diagnostics.append(f"Unresolved erd_relationship arguments on {model_id}")
                elif audit_name not in ("not_null", "accepted_values"):
                    diagnostics.append(f"Audit {audit_name} on {model_id} is not interpreted as relationship/uniqueness evidence")
            models.append({
                "id": model_id, "name": aliases[model_id], "schema": model.schema_name,
                "description": model.description or "", "dialect": model.dialect,
                "kind": model.kind.name.value, "sourcePath": source_path,
                "columnsKnown": types is not None,
                "columnSource": "declared" if model.columns_to_types_ is not None else "inferred",
                "identifierFolding": identifier_folding(model.dialect),
                "columns": [{"name": name, "dataType": None if dtype.is_type(exp.DataType.Type.UNKNOWN) else dtype.sql(dialect=model.dialect),
                             "description": descriptions.get(name, "")} for name, dtype in (types or {}).items()],
                "uniqueKeys": keys,
            })
        # Incomplete schemas should suppress unsupported evidence, not invalidate
        # the entire export (for example an external table without known columns).
        columns_by_id = {m["id"]: {c["name"] for c in m["columns"]} for m in models}
        for model in models:
            valid_keys = [key for key in model["uniqueKeys"] if all(c in columns_by_id[model["id"]] for c in key)]
            if valid_keys != model["uniqueKeys"]:
                diagnostics.append(f"Uniqueness columns unavailable on {model['id']}; evidence omitted")
            model["uniqueKeys"] = valid_keys
        valid_relationships = []
        for relationship in relationships:
            if (relationship["fromColumn"] in columns_by_id[relationship["fromId"]]
                    and relationship["toColumn"] in columns_by_id[relationship["toId"]]):
                if relationship not in valid_relationships:
                    valid_relationships.append(relationship)
            else:
                diagnostics.append(f"Relationship columns unavailable for {relationship['fromId']} -> {relationship['toId']}; edge omitted")
        warehouse = inspect_warehouse(context, root, environment, models) if environment is not None else None
        after = hashes(root, semantic)
        if before != after:
            raise ValueError("Project changed during export; retry refresh")
        return {"schemaVersion": 2, "provider": "sqlmesh", "generatedAt": datetime.now(timezone.utc).isoformat(),
                "sqlmeshVersion": importlib.metadata.version("sqlmesh"), "gateway": gateway, "config": config,
                "models": models, "relationships": valid_relationships, "inputs": after, "diagnostics": diagnostics,
                "warehouse": warehouse}
    finally:
        context.close()
        # Context.close() does not close adapters when no evaluator was created.
        adapters = list(context.__dict__.get("engine_adapters", {}).values())
        if context._engine_adapter is not None:
            adapters.append(context._engine_adapter)
        for adapter in {id(a): a for a in adapters}.values():
            adapter.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--semantic-dir", default=".erd-studio")
    parser.add_argument("--gateway")
    parser.add_argument("--config")
    parser.add_argument("--environment", help="Opt in to read-only DuckDB inspection of a deployed environment")
    args = parser.parse_args()
    root = args.project.resolve()
    semantic = (root / args.semantic_dir).resolve()
    if not semantic.is_relative_to(root) or semantic == root:
        parser.error("--semantic-dir must be a directory within the project")
    snapshot = export_project(root, semantic, args.gateway, args.config, args.environment)
    semantic.mkdir(parents=True, exist_ok=True)
    destination = semantic / "sqlmesh.json"
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", dir=semantic, delete=False) as temp:
            temp_name = temp.name
            json.dump(snapshot, temp, indent=2)
            temp.write("\n")
        os.replace(temp_name, destination)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)
    print(f"Exported {len(snapshot['models'])} models to {destination}")


if __name__ == "__main__":
    main()
