// Vocabulary prompt fed to Whisper before every utterance. Whisper imitates the style and spelling of this text,
// so it is written as a plausible operative-note fragment packed with the terms clinicians dictate most.
// Keep it under ~180 tokens; the user's custom vocabulary and the previous sentence are appended at run time.
window.PARROT_PROMPT = [
  "Operative note. Laparoscopic cholecystectomy, appendectomy, colectomy, inguinal hernia repair, Nissen fundoplication,",
  "hiatal hernia, LINX, transversus abdominis release, retromuscular mesh, Hartmann's procedure, ileostomy, colostomy, anastomosis.",
  "Cystic duct, cystic artery, Hem-o-lok clips, LigaSure, Bovie, Veress needle, pneumoperitoneum, 12 mm trocar, Endo GIA stapler.",
  "Sutures: 3-0 Vicryl, 4-0 Monocryl, #1 PDS, 2-0 Prolene, Ethibond, silk, nylon. Steri-Strips, Dermabond, JP drain.",
  "Diagnoses: cholelithiasis, choledocholithiasis, diverticulitis, small bowel obstruction, perforated appendicitis, abscess, hemorrhoids, pilonidal cyst.",
  "ED: laceration repair, incision and drainage, reduction, splint, tetanus, lidocaine with epinephrine, CT abdomen and pelvis, EBL, PACU."
].join(' ');
