"""Real dbt/DuckDB test execution in a disposable directory; no warehouse credentials."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class TupleTest(unittest.TestCase):
    def test_real_dbt_checks_tuple_membership_and_rejects_malformed_arguments(self):
        executable = os.environ.get('DBT_EXECUTABLE') or shutil.which('dbt')
        if not executable:
            self.skipTest('Set DBT_EXECUTABLE to a dbt-duckdb environment to run the real integration test')
        with tempfile.TemporaryDirectory(prefix='erd-dbt-tuple-') as temp:
            project = Path(temp)
            shutil.copytree(ROOT / 'test/fixtures/dbt-composite-project', project, dirs_exist_ok=True)
            generic = project / 'tests/generic'
            generic.mkdir(parents=True)
            shutil.copy(Path(__file__).parent / 'tests/generic/erd_relationship_tuple.sql', generic)
            env = {**os.environ, 'DBT_SEND_ANONYMOUS_USAGE_STATS': 'false'}
            def run(*args):
                return subprocess.run([executable, *args, '--profiles-dir', str(project)], cwd=project,
                                      env=env, capture_output=True, text=True, timeout=120)
            built = run('run')
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            tested = run('test')
            self.assertEqual(tested.returncode, 1, tested.stdout + tested.stderr)
            results = json.loads((project / 'target/run_results.json').read_text())['results']
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]['status'], 'fail')
            self.assertEqual(results[0]['failures'], 2)  # (1,20) and (3,99); partial NULLs and duplicates pass.
            manifest = json.loads((project / 'target/manifest.json').read_text())
            test = next(n for n in manifest['nodes'].values() if n['resource_type'] == 'test')
            self.assertEqual(test['test_metadata']['kwargs']['from_columns'], ['Child A', 'b'])
            # Now prove the same real test passes on valid tuples and partial-null children.
            child = project / 'models/child.sql'
            child.write_text(child.read_text().replace('(1, 20), ', '').replace(', (3, 99)', ''))
            built = run('build')
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            schema = project / 'models/schema.yml'
            schema.write_text(schema.read_text().replace('to_columns: [x, y]', 'to_columns: [x]'))
            invalid = run('parse')
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn('equal-length column lists', invalid.stdout + invalid.stderr)

if __name__ == '__main__':
    unittest.main()
