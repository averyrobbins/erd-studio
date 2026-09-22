"""Opt-in PostgreSQL acceptance. DSN must target a disposable cluster, never user data.

ERD_TEST_POSTGRES_DSN='host=/tmp port=55437 user=erd_admin dbname=postgres' \
  python -m unittest discover -s integrations/sqlmesh -p test_warehouse_postgres.py -v

Creates random databases/roles and drops only those objects in teardown. The DSN
requires CREATE DATABASE/ROLE; production inspection needs only SELECT/USAGE.
"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch, PropertyMock
from contextlib import closing

from sqlmesh.core.context import Context

spec = importlib.util.spec_from_file_location('erd_export_pg', Path(__file__).with_name('export.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


@unittest.skipUnless(os.environ.get('ERD_TEST_POSTGRES_DSN'), 'Set ERD_TEST_POSTGRES_DSN for disposable PostgreSQL acceptance')
class PostgresWarehouseTest(unittest.TestCase):
    def setUp(self):
        import psycopg2
        from psycopg2 import sql
        self.admin = psycopg2.connect(os.environ['ERD_TEST_POSTGRES_DSN'])
        self.admin.autocommit = True
        self.token = uuid.uuid4().hex[:12]
        self.owner, self.reader, self.database = [f'erd_{kind}_{self.token}' for kind in ('owner', 'reader', 'db')]
        self.password = uuid.uuid4().hex
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.semantic = self.root / '.erd-studio'
        self.semantic.mkdir()
        self.addCleanup(self.cleanup_database)
        with self.admin.cursor() as c:
            for role in (self.owner, self.reader):
                c.execute(sql.SQL('CREATE ROLE {} LOGIN PASSWORD %s').format(sql.Identifier(role)), (self.password,))
            c.execute(sql.SQL('CREATE DATABASE {} OWNER {}').format(sql.Identifier(self.database), sql.Identifier(self.owner)))
        params = self.admin.get_dsn_parameters()
        self.connection = dict(type='postgres', host='127.0.0.1', port=int(params['port']),
                               user=self.owner, password=self.password, database=self.database, sslmode='disable')
        self.write_config()
        (self.root / 'models').mkdir()
        (self.root / 'models/orders.sql').write_text('MODEL (name demo.orders, kind FULL); SELECT 1::INT AS "Order Number";')
        (self.semantic / 'sqlmesh-bindings.json').write_text(json.dumps({
            'version': 1, 'models': {'orders': 'demo.orders'}, 'columns': {'orders': {'order_number': 'Order Number'}}}))

    def cleanup_database(self):
        from psycopg2 import sql
        try:
            with self.admin.cursor() as c:
                c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(self.database)))
                for role in (self.reader, self.owner):
                    c.execute(sql.SQL('DROP ROLE IF EXISTS {}').format(sql.Identifier(role)))
        finally:
            self.admin.close()
            self.temp.cleanup()

    def write_config(self, reader=False):
        connection = {**self.connection, 'user': self.reader if reader else self.owner}
        (self.root / 'config.yaml').write_text(json.dumps({
            'gateways': {'local': {'connection': connection}}, 'default_gateway': 'local',
            'model_defaults': {'dialect': 'postgres', 'start': '2020-01-01'}}))

    def deploy(self, environment='dev'):
        with closing(Context(paths=str(self.root))) as context:
            context.plan(environment, start='2020-01-01', end='2020-01-02', no_prompts=True, auto_apply=True)
        import psycopg2
        from psycopg2 import sql
        with psycopg2.connect(**{k: v for k, v in self.connection.items() if k != 'type'}) as db:
            with db.cursor() as c:
                c.execute("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema'")
                for (schema,) in c.fetchall():
                    c.execute(sql.SQL('GRANT USAGE ON SCHEMA {} TO {}').format(sql.Identifier(schema), sql.Identifier(self.reader)))
                    c.execute(sql.SQL('GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}').format(sql.Identifier(schema), sql.Identifier(self.reader)))
        self.write_config(reader=True)

    def inspect(self, environment='dev'):
        with patch.object(Context, 'plan', side_effect=AssertionError('plan called')), \
             patch.object(Context, 'apply', side_effect=AssertionError('apply called')), \
             patch.object(Context, 'run', side_effect=AssertionError('run called')), \
             patch.object(Context, 'state_sync', new_callable=PropertyMock, side_effect=AssertionError('state accessor called')):
            return exporter.export_project(self.root, self.semantic, None, None, environment)

    def test_deployed_relation_with_restricted_role_and_exact_binding(self):
        self.deploy()
        result = self.inspect()
        self.assertNotIn('diagnostic', result['warehouse'])
        observation = result['warehouse']['models'][0]
        self.assertEqual(observation['status'], 'observed')
        self.assertIn('demo__dev', observation['relation'])
        self.assertEqual(observation['columns'][0]['name'], 'Order Number')
        self.assertEqual(result['models'][0]['columnBindings'], {'order_number': 'Order Number'})
        self.assertNotIn(self.password, json.dumps(result))

    def test_connection_is_read_only_even_with_database_owner(self):
        import psycopg2
        from sqlmesh.core.config.connection import PostgresConnectionConfig
        adapter, _ = exporter.readonly_postgres_adapter(PostgresConnectionConfig(**self.connection))
        try:
            self.assertEqual(adapter.fetchone('SHOW transaction_read_only')[0], 'on')
            with self.assertRaises(psycopg2.errors.ReadOnlySqlTransaction):
                adapter.execute('CREATE TABLE public.must_not_exist (id INT)')
        finally:
            adapter.close()

    def test_missing_state_is_not_initialized(self):
        result = self.inspect()
        self.assertEqual(result['warehouse']['models'][0]['status'], 'unavailable')
        self.assertIn('No readable SQLMesh state', result['warehouse']['diagnostic'])
        import psycopg2
        with psycopg2.connect(**{k: v for k, v in self.connection.items() if k != 'type'}) as db:
            with db.cursor() as c:
                c.execute("SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")
                self.assertEqual(c.fetchone()[0], 0)

    def test_source_drift_does_not_replace_observed_types(self):
        self.deploy()
        (self.root / 'models/orders.sql').write_text('MODEL (name demo.orders, kind FULL); SELECT \'one\'::TEXT AS "Order Number";')
        result = self.inspect()
        self.assertEqual(result['models'][0]['columns'][0]['dataType'], 'TEXT')
        self.assertIn(result['warehouse']['models'][0]['columns'][0]['dataType'], ('INT', 'INTEGER'))

    def test_missing_environment_and_permission_failure_are_unavailable(self):
        self.deploy()
        self.assertIn('was not found', self.inspect('missing')['warehouse']['diagnostic'])
        import psycopg2
        from psycopg2 import sql
        with psycopg2.connect(**{k: v for k, v in self.connection.items() if k != 'type'}) as db:
            with db.cursor() as c:
                c.execute(sql.SQL('REVOKE SELECT ON ALL TABLES IN SCHEMA sqlmesh FROM {}').format(sql.Identifier(self.reader)))
        result = self.inspect()
        self.assertEqual(result['warehouse']['models'][0]['status'], 'unavailable')
        self.assertNotIn(self.password, json.dumps(result))
