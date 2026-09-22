import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch, PropertyMock

from sqlmesh.core.context import Context

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("erd_export", Path(__file__).with_name("export.py"))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        shutil.copytree(ROOT / "test/fixtures/sqlmesh-project", self.root, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(".cache", "logs", "__pycache__"))
        self.semantic = self.root / ".erd-studio"

    def tearDown(self):
        self.temp.cleanup()

    def export(self):
        # A metadata refresh must never deploy or evaluate a model.
        with patch.object(Context, "plan", side_effect=AssertionError("plan called")), \
             patch.object(Context, "apply", side_effect=AssertionError("apply called")), \
             patch.object(Context, "run", side_effect=AssertionError("run called")), \
             patch.object(Context, "evaluate", side_effect=AssertionError("evaluate called")):
            return exporter.export_project(self.root, self.semantic, None, None)

    def test_model_kinds_names_and_relationships(self):
        result = self.export()
        models = {m["name"]: m for m in result["models"]}
        self.assertEqual(models["dim_customer"]["uniqueKeys"], [["customer_id"]])
        self.assertEqual(models["fct_order"]["uniqueKeys"], [["order_id"]])
        self.assertEqual(len(result["relationships"]), 1)
        self.assertEqual(result["diagnostics"], [])
        self.assertTrue(any(m["kind"] == "SEED" for m in models.values()))
        self.assertTrue(any(m["kind"] == "EXTERNAL" for m in models.values()))
        self.assertTrue(any('"python_model"' in m["id"] for m in models.values()))
        self.assertTrue(any('"generated"' in m["id"] for m in models.values()))
        self.assertFalse(any('"disabled"' in m["id"] for m in models.values()))
        self.assertEqual(len([m for m in models.values() if m["id"].endswith('."dim_customer"')]), 2)
        self.assertEqual(len(models), len({m["id"] for m in models.values()}))
        self.assertEqual(models["dim_customer"]["sourcePath"], "models/dim_customer.sql")

    def test_pending_binding_becomes_a_loaded_model_after_source_creation(self):
        file = self.semantic / "sqlmesh-bindings.json"
        bindings = json.loads(file.read_text())
        bindings["models"]["new_design"] = "analytics.new_design"
        file.write_text(json.dumps(bindings))
        result = self.export()
        self.assertEqual(result["pendingModels"], [{"name": "new_design", "id": '"memory"."analytics"."new_design"', "dialect": "duckdb"}])
        self.assertFalse(any(m["name"] == "new_design" for m in result["models"]))
        (self.root / "models/new_design.sql").write_text(
            "MODEL (name analytics.new_design, kind FULL); SELECT customer_id FROM analytics.dim_customer;")
        result = self.export()
        self.assertNotIn("pendingModels", result)
        self.assertTrue(any(m["name"] == "new_design" for m in result["models"]))

    def test_pending_bindings_require_unique_qualified_native_ids(self):
        file = self.semantic / "sqlmesh-bindings.json"
        bindings = json.loads(file.read_text())
        bindings["models"]["new_design"] = "unqualified"
        file.write_text(json.dumps(bindings))
        with self.assertRaisesRegex(ValueError, "schema-qualified"):
            self.export()
        bindings["models"]["new_design"] = "analytics.new_design"
        bindings["models"]["other_alias"] = "analytics.new_design"
        file.write_text(json.dumps(bindings))
        with self.assertRaisesRegex(ValueError, "Multiple aliases for pending"):
            self.export()

    def test_export_is_stamped_with_a_verifiable_integrity_hash(self):
        result = self.export()
        self.assertRegex(result["integrity"], r"^sha256:[a-f0-9]{64}$")
        self.assertEqual(exporter.with_integrity(result)["integrity"], result["integrity"])
        tampered = json.loads(json.dumps(result))
        tampered["models"][0]["columns"].append({"name": "invented", "dataType": "INT", "description": ""})
        self.assertNotEqual(exporter.with_integrity(tampered)["integrity"], result["integrity"])
        # Canonical form: sorted keys, no whitespace, ASCII-only escapes — see canonicalJson in the editor.
        self.assertEqual(exporter.canonical_json({"b": "\u00e9\U0001f600\x7f", "a": [1, None, True]}),
                         '{"a":[1,null,true],"b":"\\u00e9\\ud83d\\ude00\\u007f"}')

    def test_explicit_column_bindings_preserve_native_metadata(self):
        file = self.semantic / "sqlmesh-bindings.json"
        bindings = json.loads(file.read_text())
        bindings["columns"] = {"fct_order": {"order_key": "order_id", "customer_key": "customer_id"}}
        file.write_text(json.dumps(bindings))
        result = self.export()
        order = next(m for m in result["models"] if m["name"] == "fct_order")
        self.assertEqual(order["columnBindings"], bindings["columns"]["fct_order"])
        self.assertEqual(order["columns"][0]["name"], "order_id")
        self.assertEqual(result["relationships"][0]["fromColumn"], "customer_id")
        self.assertIn(".erd-studio/sqlmesh-bindings.json", result["inputs"])

    def test_invalid_column_bindings_fail_before_publishing(self):
        file = self.semantic / "sqlmesh-bindings.json"
        original = json.loads(file.read_text())
        for columns in ({"absent_model": {"a": "order_id"}},
                        {"fct_order": {"a": "missing"}},
                        {"fct_order": {"a": "order_id", "b": "order_id"}},
                        {"fct_order": {"Bad Alias": "order_id"}},
                        {"fct_order": {"amount": "order_id"}}, []):
            with self.subTest(columns=columns):
                file.write_text(json.dumps({**original, "columns": columns}))
                with self.assertRaisesRegex(ValueError, "[Cc]olumn binding|columns must"):
                    self.export()

    def test_source_validation_does_not_initialize_warehouse_state(self):
        database = self.root / "warehouse.duckdb"
        config = self.root / "config.yaml"
        config.write_text(config.read_text().replace("':memory:'", json.dumps(str(database))))
        with patch.object(Context, "state_sync", new_callable=PropertyMock,
                          side_effect=AssertionError("state_sync accessed")), \
             patch.object(Context, "state_reader", new_callable=PropertyMock,
                          side_effect=AssertionError("state_reader accessed")):
            result = self.export()
        self.assertTrue(result["models"])
        self.assertFalse(database.exists(), "Source-only validation must not create SQLMesh state")

    def test_input_files_agree_with_the_editor_on_symlinks(self):
        import os
        outside = Path(tempfile.mkdtemp())
        try:
            (outside / "external.sql").write_text("SELECT 1")
            (outside / "linked_dir").mkdir()
            (outside / "linked_dir" / "hidden_model.sql").write_text("SELECT 2")
            os.symlink(self.root / "models" / "dim_customer.sql", self.root / "models" / "inside_link.sql")
            os.symlink(outside / "external.sql", self.root / "models" / "outside_link.sql")
            os.symlink(outside / "linked_dir", self.root / "models" / "dir_link")
            os.symlink(self.root / "models" / "fct_order.sql", self.root / "models" / "dangling.sql")
            os.unlink(self.root / "models" / "fct_order.sql")
            listed = {p.relative_to(self.root).as_posix() for p in exporter.input_files(self.root, self.semantic)}
            self.assertIn("models/inside_link.sql", listed)          # a symlink to a project file is an input
            self.assertNotIn("models/outside_link.sql", listed)      # never read outside the project
            self.assertFalse(any(f.startswith("models/dir_link") for f in listed))  # directory symlinks are not descended
            self.assertNotIn("models/dangling.sql", listed)          # a broken link is not a file
            self.assertNotIn("models/fct_order.sql", listed)
        finally:
            shutil.rmtree(outside)

    def test_aliases_survive_added_models_and_explicit_bindings(self):
        old = {m["id"]: m["name"] for m in self.export()["models"]}
        (self.root / "models/new.sql").write_text("MODEL (name elsewhere.dim_customer); SELECT 2::INT AS id")
        new = {m["id"]: m["name"] for m in self.export()["models"]}
        self.assertTrue(all(new[k] == v for k, v in old.items()))
        self.assertIn("models/new.sql", self.export()["inputs"])

    def test_invalid_binding_is_reported_without_replacing_an_export(self):
        destination = self.semantic / "sqlmesh.json"
        before = destination.read_bytes()
        (self.semantic / "sqlmesh-bindings.json").write_text(json.dumps({"version": 1, "models": {"../bad": "analytics.dim_customer"}}))
        with self.assertRaises(ValueError):
            self.export()
        self.assertEqual(destination.read_bytes(), before)

    def test_fk_audit_rejects_orphans_and_allows_nulls(self):
        context = Context(paths=str(self.root))
        try:
            model = context.get_model("analytics.fct_order")
            name, kwargs = next(a for a in model.audits if a[0] == "erd_relationship")
            audit = context._audits[name]
            query = model.render_audit_query(audit, **kwargs)
            import duckdb
            connection = duckdb.connect()
            try:
                connection.execute("CREATE SCHEMA analytics")
                connection.execute("CREATE TABLE analytics.dim_customer AS SELECT 1 AS customer_id")
                connection.execute("CREATE TABLE analytics.fct_order(customer_id INT)")
                connection.execute("INSERT INTO analytics.fct_order VALUES (1), (NULL), (999)")
                rows = connection.execute(query.sql(dialect="duckdb")).fetchall()
                self.assertEqual(rows, [(999,)])
            finally:
                connection.close()
        finally:
            context.close()

    def test_tuple_audit_exports_one_edge_and_checks_same_parent_row(self):
        shutil.copy(ROOT / "integrations/sqlmesh/audits/erd_relationship_tuple.sql", self.root / "audits")
        (self.root / "models/tuple_parent.sql").write_text(
            "MODEL (name analytics.tuple_parent, kind FULL, audits (unique_combination_of_columns(columns := (a, b)))); "
            "SELECT 1::INT AS a, 10::INT AS b;")
        (self.root / "models/tuple_child.sql").write_text(
            'MODEL (name analytics.tuple_child, kind FULL, depends_on (analytics.tuple_parent), '
            'audits (erd_relationship_tuple(pairs := (("Child A", a), (y, b)), to := analytics.tuple_parent))); '
            'SELECT 1::INT AS "Child A", 10::INT AS y;')
        result = self.export()
        edge = next(r for r in result["relationships"] if r["audit"] == "erd_relationship_tuple")
        self.assertEqual(edge["columnPairs"], [{"fromColumn": "child a", "toColumn": "a"}, {"fromColumn": "y", "toColumn": "b"}])
        self.assertEqual(edge["fromColumn"], "child a")
        self.assertEqual(edge["toColumn"], "a")
        context = Context(paths=str(self.root), load_state=False)
        try:
            model = context.get_model("analytics.tuple_child")
            name, kwargs = model.audits[0]
            query = model.render_audit_query(context._audits[name], **kwargs)
            import duckdb
            with duckdb.connect() as db:
                db.execute("CREATE SCHEMA analytics")
                db.execute("CREATE TABLE analytics.tuple_parent(a INT, b INT)")
                db.execute("INSERT INTO analytics.tuple_parent VALUES (1, 10), (2, 20), (NULL, 99)")
                db.execute('CREATE TABLE analytics.tuple_child("Child A" INT, y INT)')
                db.execute("INSERT INTO analytics.tuple_child VALUES (1,10), (1,10), (1,20), (NULL,20), (1,NULL), (3,99)")
                self.assertEqual(sorted(db.execute(query.sql(dialect="duckdb")).fetchall()), [(1,20), (3,99)])
        finally:
            context.close()

    def test_tuple_export_refuses_duplicate_or_unavailable_components(self):
        shutil.copy(ROOT / "integrations/sqlmesh/audits/erd_relationship_tuple.sql", self.root / "audits")
        for pairs in ['((a, customer_id), (a, name))', '((a, customer_id), (b, customer_id))',
                      '((a, customer_id), (missing, name))', '((a, customer_id), (b, missing))']:
            with self.subTest(pairs=pairs):
                (self.root / "models/tuple_child.sql").write_text(
                    f'MODEL (name analytics.tuple_child, kind FULL, depends_on (analytics.dim_customer), '
                    f'audits (erd_relationship_tuple(pairs := {pairs}, to := analytics.dim_customer))); '
                    'SELECT 1::INT AS a, 10::INT AS b;')
                result = self.export()
                self.assertFalse(any(r["audit"] == "erd_relationship_tuple" for r in result["relationships"]))
                self.assertTrue(any("arguments" in d or "columns unavailable" in d for d in result["diagnostics"]))

    def test_dialect_normalization_preserves_distinct_quoted_columns(self):
        (self.root / "models/case_sensitive.sql").write_text('''
MODEL (name analytics.case_sensitive, dialect snowflake,
       audits (unique_values(columns := (id, "id"))));
SELECT 1::INT AS id, 2::INT AS "id";
''')
        result = self.export()
        model = next(m for m in result["models"] if m["id"].endswith('."CASE_SENSITIVE"'))
        self.assertEqual([c["name"] for c in model["columns"]], ["ID", "id"])
        self.assertEqual(model["uniqueKeys"], [["ID"], ["id"]])
        # The folding tells the editor a logical `id` names the unquoted `ID` here,
        # while the DuckDB fixture models fold to lowercase.
        self.assertEqual(model["identifierFolding"], "upper")
        self.assertEqual({m["identifierFolding"] for m in result["models"] if m["id"] != model["id"]}, {"lower"})

    def test_identifier_folding_follows_the_dialect(self):
        self.assertEqual(exporter.identifier_folding("duckdb"), "lower")
        self.assertEqual(exporter.identifier_folding("postgres"), "lower")
        self.assertEqual(exporter.identifier_folding("bigquery"), "lower")
        self.assertEqual(exporter.identifier_folding("snowflake"), "upper")
        self.assertEqual(exporter.identifier_folding("oracle"), "upper")
        self.assertEqual(exporter.identifier_folding("clickhouse"), "exact")
        self.assertEqual(exporter.identifier_folding("not_a_dialect"), "exact")

    def test_fk_target_missing_from_dependencies_is_diagnosed_but_still_exported(self):
        # SQLMesh builds the DAG from the query, not from audits: a parent that the
        # child never selects from must be declared with depends_on, or the audit
        # runs before the parent exists. The edge is declared intent and is kept.
        (self.root / "models/fct_return.sql").write_text(
            "MODEL (name analytics.fct_return, kind FULL,"
            " audits (erd_relationship(column := customer_id, to := analytics.dim_customer, field := customer_id)));"
            " SELECT 7::INT AS return_id, 1::INT AS customer_id;")
        result = self.export()
        edge = next(r for r in result["relationships"] if r["fromId"].endswith('."fct_return"'))
        self.assertTrue(edge["toId"].endswith('."dim_customer"'))
        warnings = [d for d in result["diagnostics"] if "not a dependency" in d]
        self.assertEqual(len(warnings), 1, result["diagnostics"])
        self.assertIn('"fct_return"', warnings[0])
        self.assertIn("depends_on (analytics.dim_customer)", warnings[0])
        # The fixture's fct_order selects from dim_customer, so it stays clean.
        self.assertFalse(any('"fct_order"' in d for d in warnings))
        # Declaring the dependency clears the diagnostic without changing the edge.
        (self.root / "models/fct_return.sql").write_text(
            "MODEL (name analytics.fct_return, kind FULL, depends_on (analytics.dim_customer),"
            " audits (erd_relationship(column := customer_id, to := analytics.dim_customer, field := customer_id)));"
            " SELECT 7::INT AS return_id, 1::INT AS customer_id;")
        result = self.export()
        self.assertFalse(any("not a dependency" in d for d in result["diagnostics"]))
        self.assertTrue(any(r["fromId"].endswith('."fct_return"') for r in result["relationships"]))

    def test_unavailable_audit_endpoints_produce_diagnostics(self):
        file = self.root / "models/fct_order.sql"
        file.write_text(file.read_text().replace("field := customer_id", "field := unavailable"))
        result = self.export()
        self.assertEqual(result["relationships"], [])
        self.assertTrue(any("Relationship columns unavailable" in d for d in result["diagnostics"]))


if __name__ == "__main__":
    unittest.main()
