{% test erd_relationship_tuple(model, from_columns, to, to_columns) %}
  {# One tuple FK; any NULL child component is exempt (MATCH SIMPLE). #}
  {% if from_columns is string or to_columns is string or from_columns is mapping or to_columns is mapping
        or from_columns is not sequence or to_columns is not sequence
        or from_columns | length < 2 or from_columns | length != to_columns | length %}
    {{ exceptions.raise_compiler_error('erd_relationship_tuple requires equal-length column lists with at least two pairs') }}
  {% endif %}
  {% for name in from_columns + to_columns %}
    {% if name is not string or not name | trim %}
      {{ exceptions.raise_compiler_error('erd_relationship_tuple columns must be nonempty identifier names') }}
    {% endif %}
  {% endfor %}
  {% if from_columns | unique(case_sensitive=true) | list | length != from_columns | length
        or to_columns | unique(case_sensitive=true) | list | length != to_columns | length %}
    {{ exceptions.raise_compiler_error('erd_relationship_tuple columns must be distinct on each side') }}
  {% endif %}
  select child.*
  from {{ model }} as child
  where
    {% for col in from_columns %}
      child.{{ adapter.quote(col) }} is not null {% if not loop.last %}and{% endif %}
    {% endfor %}
    and not exists (
      select 1 from {{ to }} as parent
      where
        {% for col in from_columns %}
          child.{{ adapter.quote(col) }} = parent.{{ adapter.quote(to_columns[loop.index0]) }}
          {% if not loop.last %}and{% endif %}
        {% endfor %}
    )
{% endtest %}
