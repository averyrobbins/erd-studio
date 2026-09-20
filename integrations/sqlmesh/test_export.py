import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

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
