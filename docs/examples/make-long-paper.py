# Makes a long paper (187 pages, thousands of answer spaces) for testing how TypePDF copes with big documents.
#   python3 docs/examples/make-long-paper.py /tmp/long-paper.pdf [pages]      (needs reportlab)
import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

W, H = A4
N = int(sys.argv[2]) if len(sys.argv) > 2 else 187
c = canvas.Canvas(sys.argv[1] if len(sys.argv) > 1 else "long-paper.pdf")
c.setTitle("TypePDF long test paper")
TOPICS = ["electric fields", "gravitational fields", "capacitors", "magnetic flux", "radioactive decay", "circular motion",
          "simple harmonic motion", "thermal physics", "ideal gases", "momentum", "projectiles", "waves", "refraction",
          "photoelectric effect", "particles", "materials", "DC circuits", "potential dividers"]
q = 0
for pg in range(1, N + 1):
    y = H - 60
    for k in range(4):
        q += 1
        topic = TOPICS[(q - 1) % len(TOPICS)]
        c.setFont("Helvetica-Bold", 11); c.drawString(50, y, str(q))
        c.setFont("Helvetica", 10.5); c.drawString(72, y, f"This question is about {topic}. Explain what is meant by the term below.")
        y -= 26
        c.setDash(1, 2); c.setLineWidth(0.6)
        for _ in range(2): c.line(72, y, W - 60, y); y -= 24
        c.setDash()
        c.setFont("Helvetica-Bold", 10); c.drawRightString(W - 50, y + 6, "[2]")
        y -= 14
    # a results table: 6 rows x 4 empty cells
    c.setFont("Helvetica", 10); c.drawString(72, y, "Complete the table of results.")
    y -= 10
    cw, rh, x0 = 100, 22, 72
    c.setLineWidth(0.8)
    for r in range(7):
        c.line(x0, y - r * rh, x0 + 4 * cw, y - r * rh)
    for k in range(5):
        c.line(x0 + k * cw, y, x0 + k * cw, y - 6 * rh)
    for k, h in enumerate(["Length / m", "Time / s", "Force / N", "Mass / kg"]):
        c.drawString(x0 + k * cw + 6, y - 15, h)
    c.setFont("Helvetica", 8); c.drawString(50, 30, "TypePDF long test paper"); c.drawRightString(W - 50, 30, str(pg))
    c.showPage()
c.save()
