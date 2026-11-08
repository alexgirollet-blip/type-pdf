# Makes docs/examples/aqa-cover.pdf: an AQA-style front cover (candidate boxes, a "For Examiner's Use" table with a
# row per question, a multiple-choice range row and TOTAL, and almost no free space) and one question page.
#   python3 docs/examples/make-aqa-cover.py docs/examples/aqa-cover.pdf      (needs reportlab)
import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

W, H = A4
c = canvas.Canvas(sys.argv[1] if len(sys.argv) > 1 else "aqa-cover.pdf")
c.setFont("Helvetica-Bold", 30); c.drawString(40, H - 70, "AQA")
c.roundRect(30, H - 330, W - 60, 230, 14)
c.setFont("Helvetica", 12); c.drawString(50, H - 125, "Please write clearly in block capitals.")
c.drawString(50, H - 165, "Centre number"); c.drawString(330, H - 165, "Candidate number")
for i in range(5): c.rect(150 + i * 32, H - 175, 30, 26)
for i in range(4): c.rect(440 + i * 32, H - 175, 30, 26)
for k, lab in enumerate(["Surname", "Forename(s)", "Candidate signature"]):
    y = H - 215 - k * 38; c.drawString(50, y, lab); c.rect(200, y - 8, W - 250, 24)
c.setFont("Helvetica-Bold", 26); c.drawString(40, H - 390, "A-level"); c.drawString(40, H - 425, "PHYSICS")
c.setFont("Helvetica", 16); c.drawString(40, H - 455, "Paper 1")
c.setLineWidth(3); c.line(30, H - 480, W - 30, H - 480); c.setLineWidth(1)
c.setFont("Helvetica", 13); c.drawString(30, H - 505, "Thursday 15 June 2017"); c.drawString(250, H - 505, "Morning"); c.drawString(410, H - 505, "Time allowed: 2 hours")
c.setFont("Helvetica-Bold", 12); c.drawString(30, H - 540, "Materials")
c.setFont("Helvetica", 10)
for k, t in enumerate(["For this paper you must have:", "- a pencil and a ruler", "- a scientific calculator", "- a Data and Formulae booklet."]): c.drawString(30, H - 556 - k * 13, t)
c.setFont("Helvetica-Bold", 12); c.drawString(30, H - 625, "Instructions")
c.setFont("Helvetica", 10)
for k, t in enumerate(["- Use black ink or black ball-point pen.", "- Answer all questions.", "- Show all your working."]): c.drawString(30, H - 641 - k * 13, t)
c.setFont("Helvetica-Bold", 12); c.drawString(30, H - 700, "Information")
c.setFont("Helvetica", 10)
for k, t in enumerate(["- The marks for questions are shown in brackets.", "- The maximum mark for this paper is 85."]): c.drawString(30, H - 716 - k * 13, t)
# For Examiner's Use: Question | Mark
x0, top, cw, rh = 400, H - 520, 70, 22
rows = ["1", "2", "3", "8–32", "TOTAL"]
c.rect(x0, top - rh, 2 * cw, rh); c.setFont("Helvetica", 10); c.drawCentredString(x0 + cw, top - 15, "For Examiner's Use")
c.rect(x0, top - 2 * rh, cw, rh); c.rect(x0 + cw, top - 2 * rh, cw, rh)
c.drawCentredString(x0 + cw / 2, top - rh - 15, "Question"); c.drawCentredString(x0 + cw * 1.5, top - rh - 15, "Mark")
for k, t in enumerate(rows):
    y = top - (k + 2) * rh
    c.rect(x0, y - rh, cw, rh); c.rect(x0 + cw, y - rh, cw, rh)
    c.setFont("Helvetica-Bold" if t == "TOTAL" else "Helvetica", 11); c.drawCentredString(x0 + cw / 2, y - 15, t)
c.showPage()
# a question page
def rules(y0, n, x0=70, x1=W - 60, sp=26):
    c.setDash(1, 2); c.setLineWidth(0.6)
    for k in range(n): c.line(x0, y0 - k * sp, x1, y0 - k * sp)
    c.setDash()
c.setFont("Helvetica-Bold", 11); c.drawString(50, H - 70, "0 1"); c.setFont("Helvetica", 11); c.drawString(80, H - 70, "State what is meant by the photoelectric effect.")
c.drawRightString(W - 60, H - 88, "[2 marks]"); rules(H - 115, 3)
c.setFont("Helvetica-Bold", 11); c.drawString(50, H - 230, "0 2"); c.setFont("Helvetica", 11); c.drawString(80, H - 230, "Define the work function.")
c.drawRightString(W - 60, H - 248, "[1 mark]"); rules(H - 275, 2)
c.showPage(); c.save()
