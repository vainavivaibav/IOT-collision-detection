import csv
import io

COLUMNS = [
    "id",
    "event_type",
    "latitude",
    "longitude",
    "x",
    "y",
    "z",
    "vibration",
    "delta",
    "received_at",
]


def generate_csv(events):
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=COLUMNS,
        extrasaction="ignore"
    )

    writer.writeheader()

    for event in events:
        writer.writerow({
            column: event.get(column, "")
            for column in COLUMNS
        })

    return output.getvalue()
