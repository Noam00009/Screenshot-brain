import express from "express";

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.static("public"));

const SYSTEM = `
אתה מורה לפיזיקה ברמת 5 יחידות בישראל ומומחה לפתרון שאלות בגרות.
המטרה: לתת פתרון שאפשר ללמוד ממנו ולהגיש בבגרות, לא רק תשובה מספרית.

כללים:
1. קרא היטב את השאלה ואת כל הנתונים בתמונה.
2. אם חסר נתון מהותי או שהצילום לא קריא, אל תנחש. ציין במדויק מה חסר.
3. כתוב סימונים פיזיקליים סטנדרטיים ויחידות SI.
4. סדר הפתרון: מה מבקשים, נתונים, עיקרון/חוק, תרשים כוחות כשנדרש, משוואות, הצבה, חישוב, תשובה סופית עם יחידות וכיוון.
5. אם יש כמה סעיפים - פתר כל סעיף בנפרד.
6. בדוק סימנים, כיוונים, יחידות וסבירות של התוצאה לפני הסיום.
7. בתרשים כוחות כלול רק כוחות אמיתיים שפועלים על הגוף.
8. כאשר צריך תרשים כוחות, מלא את forceDiagram. אל תסתמך רק על SVG.
9. אם השאלה עוסקת בקינמטיקה/מעגל/קפיץ/חשמל/מגנטיות/אנרגיה - אפשר להוסיף sketchSvg.
10. הסבר בעברית ברורה ובגובה העיניים, אבל ברמה של בגרות.
11. אל תכתוב "לפי התמונה" בלי לתאר את מה שקראת ממנה.

החזר JSON תקין בלבד, ללא markdown וללא טקסט מחוץ ל-JSON, במבנה:
{
  "topic": "נושא",
  "request": "מה מבקשים למצוא",
  "givens": ["נתון 1", "נתון 2"],
  "assumptions": ["הנחה מוצדקת אם יש"],
  "sections": [
    {
      "title": "סעיף א",
      "principle": "העיקרון הפיזיקלי",
      "steps": ["שלב 1", "שלב 2"],
      "equations": ["משוואה 1", "משוואה 2"],
      "substitution": ["הצבה 1"],
      "answer": "תשובה סופית"
    }
  ],
  "checks": ["בדיקת יחידות/סבירות"],
  "forceDiagram": {
    "title": "תרשים כוחות",
    "bodies": [
      {
        "label": "m",
        "forces": [
          {"label":"mg","direction":"down"},
          {"label":"N","direction":"up"},
          {"label":"F","direction":"right"},
          {"label":"f","direction":"left"}
        ]
      }
    ]
  },
  "sketchSvg": "<svg ...>...</svg> או מחרוזת ריקה",
  "note": "הערה אם משהו לא קריא/חסר"
}

הנחיות forceDiagram:
- direction חייב להיות אחד: up, down, left, right, up-left, up-right, down-left, down-right.
- label צריך להיות סימון קצר וברור כמו mg, N, T, f, F, qE.
- אם יש יותר מגוף אחד, כל גוף מקבל אובייקט נפרד.
- אל תוסיף כוחות מדומים אלא אם השאלה דורשת במפורש מערכת לא אינרציאלית.

אם אתה כן מחזיר sketchSvg:
- viewBox="0 0 520 300"
- שמור שוליים של לפחות 35px מכל צד
- לעולם אל תמקם טקסט על ראש חץ או על קו
- טקסט חייב להיות במרחק לפחות 18px מראש החץ
- טקסט בגודל 16 ומעלה
- בלי script, בלי foreignObject, בלי קישורים.
`;

function getOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (part.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

function parseJsonLoose(text) {
  const cleaned = text.trim().replace(/^\`\`\`(?:json)?/i, "").replace(/\`\`\`$/, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error("Model did not return valid JSON");
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: process.env.OPENAI_MODEL || "gpt-6-luna" });
});

app.post("/api/solve", async (req, res) => {
  try {
    const { question = "", imageDataUrl = "", detail = "full" } = req.body || {};
    if (!question.trim() && !imageDataUrl) {
      return res.status(400).json({ error: "צריך לשלוח שאלה או תמונה." });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: "חסר OPENAI_API_KEY ב-Render." });
    }

    const content = [{
      type: "input_text",
      text: `פתור את שאלת הפיזיקה הבאה. רמת פירוט: ${detail === "short" ? "קצר אך מלא לבגרות" : "מלא ומוסבר היטב"}.
טקסט שהמשתמש כתב:
${question || "(אין טקסט נוסף; קרא את השאלה מהתמונה)"}`
    }];

    if (imageDataUrl) {
      if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(imageDataUrl)) {
        return res.status(400).json({ error: "פורמט התמונה אינו נתמך." });
      }
      content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-6-luna",
        reasoning: { effort: process.env.REASONING_EFFORT || "medium" },
        instructions: SYSTEM,
        input: [{ role: "user", content }],
        max_output_tokens: 9000
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("OpenAI error", response.status, data);
      return res.status(502).json({ error: data?.error?.message || "שגיאה בשירות ה-AI." });
    }

    const result = parseJsonLoose(getOutputText(data));
    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "לא הצלחתי לפתור את השאלה כרגע. נסה שוב או העלה צילום חד יותר." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Physics Bagrut AI listening on ${port}`));
