
import io

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer
)


def generate_pdf(events):
    """Generate a PDF report from collision event dictionaries."""
    buffer = io.BytesIO()

    document = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=25,
        rightMargin=25
    )

    styles = getSampleStyleSheet()
    elements = []

    elements.append(
        Paragraph("VehicleGuard - Collision Report", styles["Title"])
    )
    elements.append(Spacer(1, 15))

    elements.append(
        Paragraph(f"Total events: {len(events)}", styles["Normal"])
    )
    elements.append(Spacer(1, 15))

    columns = [
        "ID", "Event Type", "Latitude", "Longitude",
        "X", "Y", "Z", "Vibration", "Delta", "Received At"
    ]

    data = [columns]

    for event in events:
        data.append([
            str(event.get("id", "")),
            str(event.get("event_type", "")),
            str(event.get("latitude") or ""),
            str(event.get("longitude") or ""),
            str(event.get("x", "")),
            str(event.get("y", "")),
            str(event.get("z", "")),
            str(event.get("vibration", "")),
            str(event.get("delta", "")),
            str(event.get("received_at", "")),
        ])

    table = Table(
        data,
        repeatRows=1,
        colWidths=[30, 110, 65, 65, 50, 50, 50, 65, 55, 180]
    )

    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#17365D")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 9),
        ("TOPPADDING", (0, 0), (-1, 0), 9),
    ]))

    elements.append(table)
    document.build(elements)

    return buffer.getvalue()
