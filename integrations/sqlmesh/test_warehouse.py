"""Real DuckDB/state tests. Deployment is fixture setup only; inspection is read-only."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, PropertyMock

from sqlmesh.core.context import Context
from sqlmesh.core.state_sync import EngineAdapterStateSync
from test_export import exporter


class WarehouseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.semantic = self.root / '.erd-studio'
        self.semantic.mkdir()
        self.db = self.root / 'warehouse.duckdb'
        (self.root / 'config.yaml').write_text(f'''gateways:
  local:
    connection:
      type: duckdb
      database: {self.db}
default_gateway: local
model_defaults:
  dialect: duckdb
  start: 2024-01-01
disable_anonymized_analytics: true
''')
        (self.root / 'models').mkdir()
        (self.root / 'models/orders.sql').write_text('MODEL (name demo.orders, kind FULL); SELECT 1::INT AS id;')

    def tearDown(self):
        self.temp.cleanup()

    def deploy(self, env='prod'):
        context = Context(paths=str(self.root))
        try:
            context.plan(env, execution_time='2024-01-03', auto_apply=True, no_prompts=True, skip_tests=True, include_unmodified=True)
        finally:
            context.close()

    def inspect(self, env='prod'):
        with patch.object(Context, 'state_sync', new_callable=PropertyMock, side_effect=AssertionError('state accessor used')), \
             patch.object(EngineAdapterStateSync, 'migrate', side_effect=AssertionError('migration called')), \
             patch.object(Context, 'plan', side_effect=AssertionError('plan called')), \
             patch.object(Context, 'apply', side_effect=AssertionError('apply called')), \
             patch.object(Context, 'run', side_effect=AssertionError('run called')), \
             patch.object(Context, 'evaluate', side_effect=AssertionError('evaluate called')):
            return exporter.export_project(self.root, self.semantic, None, None, env)

    def test_prod_and_dev_observations_do_not_change_database_bytes(self):
        self.deploy()
        self.deploy('dev')
        before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        for env, schema in [('prod', 'demo'), ('dev', 'demo__dev')]:
            result = self.inspect(env)
            self.assertEqual(result['schemaVersion'], 2)
            warehouse = result['warehouse']
            self.assertEqual(warehouse['environment'], env)
            observed = warehouse['models'][0]
            self.assertEqual(observed['status'], 'observed', observed)
            self.assertEqual(observed['relation'], f'"warehouse"."{schema}"."orders"')
            self.assertEqual(observed['columns'][0]['dataType'], 'INT')
            self.assertEqual(observed['id'], result['models'][0]['id'])
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), before)

    def test_source_and_deployed_schema_are_separate(self):
        self.deploy()
        (self.root / 'models/orders.sql').write_text("MODEL (name demo.orders, kind FULL); SELECT 'one'::TEXT AS id, 1::INT AS new_col;")
        result = self.inspect()
        self.assertEqual(len(result['models'][0]['columns']), 2)
        self.assertEqual(result['models'][0]['columns'][0]['dataType'], 'TEXT')
        self.assertEqual(result['warehouse']['models'][0]['columns'], [{'name': 'id', 'dataType': 'INT', 'description': ''}])

    def test_missing_environment_is_not_deployed(self):
        self.deploy()
        self.assertEqual(self.inspect('missing')['warehouse']['models'][0]['status'], 'not-deployed')

    def test_missing_database_is_never_created(self):
        result = self.inspect()
        self.assertEqual(result['warehouse']['models'][0]['status'], 'unavailable')
        self.assertFalse(self.db.exists())

    def test_uninitialized_state_is_not_migrated(self):
        import duckdb
        duckdb.connect(str(self.db)).close()
        before = self.db.read_bytes()
        result = self.inspect()
        self.assertEqual(result['warehouse']['models'][0]['status'], 'unavailable')
        self.assertEqual(self.db.read_bytes(), before)

    def test_relation_failure_is_not_treated_as_column_deletion(self):
        import duckdb
        self.deploy()
        with duckdb.connect(str(self.db)) as db:
            db.execute('DROP VIEW demo.orders')
        result = self.inspect()
        observed = result['warehouse']['models'][0]
        self.assertEqual(observed['status'], 'unavailable')
        self.assertEqual(observed['columns'], [])
        self.assertTrue(result['models'][0]['columnsKnown'])

    def test_forward_only_dev_preview_is_resolved_through_its_environment_view(self):
        file = self.root / 'models/orders.sql'
        model = 'MODEL (name demo.orders, kind INCREMENTAL_BY_TIME_RANGE(time_column ds, forward_only true)); '
        file.write_text(model + "SELECT 1::INT AS id, '2024-01-01'::DATE AS ds;")
        self.deploy()
        file.write_text(model + "SELECT 1::INT AS id, '2024-01-01'::DATE AS ds, 'preview'::TEXT AS preview;")
        self.deploy('dev')
        prod = self.inspect('prod')['warehouse']['models'][0]
        dev = self.inspect('dev')['warehouse']['models'][0]
        self.assertEqual(prod['status'], 'observed', prod)
        self.assertEqual(dev['status'], 'observed', dev)
        self.assertEqual([c['name'] for c in prod['columns']], ['id', 'ds'])
        self.assertEqual([c['name'] for c in dev['columns']], ['id', 'ds', 'preview'])

    def test_nondefault_environment_suffix_comes_from_state(self):
        config = self.root / 'config.yaml'
        config.write_text(config.read_text() + 'environment_suffix_target: table\n')
        self.deploy()
        self.deploy('review')
        observed = self.inspect('review')['warehouse']['models'][0]
        self.assertEqual(observed['status'], 'observed')
        self.assertEqual(observed['relation'], '"warehouse"."demo"."orders__review"')

    def test_inspection_releases_read_only_locks(self):
        import duckdb
        self.deploy()
        self.inspect()
        with duckdb.connect(str(self.db)) as db:
            db.execute('CREATE TABLE lock_release_check (id INT)')

    def test_custom_connection_setup_is_rejected_before_connecting(self):
        config = self.root / 'config.yaml'
        config.write_text(config.read_text().replace('      type: duckdb', '      type: duckdb\n      extensions: [httpfs]'))
        with self.assertRaisesRegex(ValueError, 'plain local DuckDB'):
            self.inspect()
        self.assertFalse(self.db.exists())


if __name__ == '__main__':
    unittest.main()
