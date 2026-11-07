# Makes docs/examples/test-paper.pdf: a short paper for trying (and testing) marking import.
#   python3 docs/examples/make-test-paper.py docs/examples/test-paper.pdf      (needs reportlab)
import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

W, H = A4
c = canvas.Canvas(sys.argv[1] if len(sys.argv) > 1 else "test-paper.pdf")
c.setTitle("TypePDF test paper")

def rules(y0, n, x0=70, x1=W - 60, sp=26):
    c.setDash(1, 2); c.setLineWidth(0.6)
    for k in range(n): c.line(x0, y0 - k * sp, x1, y0 - k * sp)
    c.setDash()

def footer(n):
    c.setFont("Helvetica", 8); c.drawString(60, 30, "TypePDF test paper"); c.drawRightString(W - 60, 30, str(n))
    c.showPage()

# 1. cover, with a box for the total
c.setFont("Helvetica-Bold", 22); c.drawString(60, H - 110, "Test Physics Paper")
c.setFont("Helvetica", 12); c.drawString(60, H - 140, "Time allowed: 20 minutes")
c.rect(380, H - 210, 150, 40); c.setFont("Helvetica-Bold", 11); c.drawString(390, H - 195, "Total Marks"); c.setFont("Helvetica", 12); c.drawString(495, H - 195, "/ 10")
c.setFont("Helvetica-Bold", 12); c.drawString(60, H - 260, "INSTRUCTIONS")
c.setFont("Helvetica", 11); c.drawString(70, H - 280, "Answer all the questions in the spaces provided.")
footer(1)

# 2. written answers
c.setFont("Helvetica-Bold", 11); c.drawString(50, H - 70, "1"); c.drawString(68, H - 70, "(a)")
c.setFont("Helvetica", 11); c.drawString(92, H - 70, "State Newton's second law of motion.")
c.drawRightString(W - 60, H - 88, "[2]"); rules(H - 115, 3)
c.setFont("Helvetica-Bold", 11); c.drawString(68, H - 215, "(b)")
c.setFont("Helvetica", 11); c.drawString(92, H - 215, "Calculate the resultant force on a 2.0 kg mass accelerating at 3.0 m/s.")
c.drawRightString(W - 60, H - 233, "[2]"); rules(H - 260, 2)
c.setFont("Helvetica-Bold", 11); c.drawString(50, H - 340, "2"); c.setFont("Helvetica", 11)
c.drawString(68, H - 340, "Draw the path of the ray through the glass block on Figure 1.")
c.drawRightString(W - 60, H - 358, "[3]")
c.rect(120, H - 600, 340, 200); c.setLineWidth(1.4); c.line(150, H - 420, 230, H - 480); c.setLineWidth(1)
c.rect(230, H - 560, 140, 100)
c.setFont("Helvetica-Bold", 10); c.drawCentredString(290, H - 620, "Figure 1")
footer(2)

# 3. multiple choice
c.setFont("Helvetica-Bold", 11); c.drawString(50, H - 70, "3"); c.setFont("Helvetica", 11)
c.drawString(68, H - 70, "Which of these is a vector quantity?")
y = H - 105
for L, t in zip("ABCD", ["mass", "speed", "velocity", "energy"]):
    c.setFont("Helvetica-Bold", 12); c.drawString(80, y, L + "."); c.setFont("Helvetica", 12); c.drawString(100, y, t); y -= 24
c.drawRightString(W - 60, y, "[1]")
c.setFont("Helvetica-Bold", 11); c.drawString(50, H - 260, "4"); c.setFont("Helvetica", 11)
c.drawString(68, H - 260, "Explain why a skydiver reaches terminal velocity.")
c.drawRightString(W - 60, H - 278, "[2]"); rules(H - 305, 3)
footer(3)

# 4. logic gates: a truth table to complete and a circuit to draw
c.setFont("Helvetica-Bold", 11); c.drawString(50, H - 70, "5"); c.setFont("Helvetica", 11)
c.drawString(68, H - 70, "Complete the truth table for an AND gate.")
c.drawRightString(W - 60, H - 88, "[2]")
x0, top, cw, rh = 150, H - 110, 70, 26
c.setLineWidth(0.8)
for i in range(6): c.line(x0, top - i * rh, x0 + 3 * cw, top - i * rh)
for j in range(4): c.line(x0 + j * cw, top, x0 + j * cw, top - 5 * rh)
c.setFont("Helvetica-Bold", 11)
for j, t in enumerate("ABQ"): c.drawCentredString(x0 + j * cw + cw / 2, top - 18, t)
c.setFont("Helvetica", 11)
for i, (a, b) in enumerate([(0, 0), (0, 1), (1, 0), (1, 1)]):
    c.drawCentredString(x0 + cw / 2, top - (i + 1) * rh - 18, str(a)); c.drawCentredString(x0 + cw * 1.5, top - (i + 1) * rh - 18, str(b))
c.setFont("Helvetica-Bold", 11); c.drawString(50, H - 290, "6"); c.setFont("Helvetica", 11)
c.drawString(68, H - 290, "Draw a logic circuit for Q = NOT (A AND B) using one logic gate.")
c.drawRightString(W - 60, H - 308, "[2]")
c.setLineWidth(1); c.rect(100, H - 560, 400, 230)
footer(4)

# 5. a crowded page, like OCR's: labelled answer lines, long answers, the next question straight after
c.setFont("Helvetica-Bold", 11); c.drawString(50, H - 60, "7"); c.drawString(68, H - 60, "(a)")
c.setFont("Helvetica", 11); c.drawString(92, H - 60, "State the purpose of each of these three buses.")
y = H - 88
for lab in ["Data bus", "Address bus", "Control bus"]:
    c.setFont("Helvetica", 11); c.drawString(70, y, lab)
    c.setDash(1, 2); c.setLineWidth(0.6); c.line(140, y - 2, W - 60, y - 2); c.line(70, y - 28, W - 60, y - 28); c.setDash()
    y -= 56
c.drawRightString(W - 60, y + 14, "[3]")
c.setFont("Helvetica-Bold", 11); c.drawString(68, y - 10, "(b)")
c.setFont("Helvetica", 11); c.drawString(92, y - 10, "Describe how a multi-level feedback queue works.")
c.drawRightString(W - 60, y - 28, "[3]"); rules(y - 52, 6)
y2 = y - 52 - 6 * 26 - 10
c.setFont("Helvetica-Bold", 11); c.drawString(68, y2, "(c)")
c.setFont("Helvetica", 11); c.drawString(92, y2, "Explain why hardware devices require a device driver.")
c.drawRightString(W - 60, y2 - 18, "[2]"); rules(y2 - 44, 4)
footer(5)
c.save()
