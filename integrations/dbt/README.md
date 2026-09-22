# Composite foreign keys in dbt

Copy [the generic test](tests/generic/erd_relationship_tuple.sql) to your project's
`tests/generic/` directory. ERD Studio source-sync plans also supply the installed
copy in `relationshipTemplates.tuple`.

```yaml
models:
  - name: fct_order_line
    data_tests:
      - erd_relationship_tuple:
          arguments:
            from_columns: [product_id, region_id]
            to: ref('dim_product_region')
            to_columns: [product_id, region_id]
```

Use flat arguments with older dbt releases. Both lists contain exact identifier
names (without SQL quotes), in corresponding order, with at least two distinct
columns per side. The macro quotes them through the adapter. ERD Studio reads
model-level `tests:` and `data_tests:` declarations, plus compiled manifest tests.

This is one tuple membership check. A child with any NULL component is exempt
(MATCH SIMPLE); add separate not-null tests if required. Non-null child tuples
must occur together in one parent row. Separate single-column relationships do
not establish this. Declare justified parent tuple uniqueness separately; neither
a relationship declaration nor its cardinality indicates that a test has run.

Run the real local DuckDB acceptance (creates/removes a temporary project):

```sh
DBT_EXECUTABLE=/path/to/dbt-duckdb/venv/bin/dbt \
  /path/to/dbt-duckdb/venv/bin/python -m unittest discover -s integrations/dbt
```

It checks false-positive combinations, NULLs, duplicates, quoted names, passing
valid data, and malformed argument lengths. Broader adapter execution remains
unverified. See the [dbt generic-test documentation](https://docs.getdbt.com/best-practices/writing-custom-generic-tests)
for installation and argument syntax.
