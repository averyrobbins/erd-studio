from sqlmesh import model
import pandas as pd


@model("analytics.python_model", columns={"id": "int", "label": "text"})
def python_model(context, **kwargs):
    # Export must discover the metadata without executing this model body.
    raise RuntimeError("A metadata export must not evaluate the Python model")


@model("analytics.generated", is_sql=True)
def generated(context, **kwargs):
    return "SELECT 1::INT AS id"
