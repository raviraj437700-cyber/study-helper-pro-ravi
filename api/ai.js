export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent';

async function gemini(parts, json) {
  let lastError = 'AI se jawab nahi aaya';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const body = { contents: [{ parts }] };
      if (json) body.generationConfig = { responseMimeType: 'application/json' };
      const r = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
      if (text) return { text };
      lastError = data?.error?.message || lastError;
      if (![429, 500, 503].includes(r.status)) break;
    } catch (e) {
      lastError = 'Server error';
    }
    await sleep(2000 * (attempt + 1));
  }
  return { error: 'AI abhi busy hai, 1-2 minute baad dobara try karo. 🙏\n\n(' + lastError + ')' };
}

const parseJSON = (t) => JSON.parse(t.replace(/```json|```/g, '').trim());

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST' });
  const b = req.body || {};
  const LANG = ['Hinglish', 'Hindi', 'English'].includes(b.lang) ? b.lang : 'Hinglish';
  const bad = (msg) => res.status(400).json({ error: msg });

  /* ---------- ROADMAP ---------- */
  if (b.mode === 'roadmap') {
    const { name, days, hours, subjects } = b;
    if (!days || !hours || !Array.isArray(subjects) || !subjects.length) return bad('Data adhoora hai');
    const list = subjects.slice(0, 12).map(s => `- ${String(s.name).slice(0, 40)}: ${Number(s.chapters)} chapters`).join('\n');
    const total = subjects.reduce((a, s) => a + (Number(s.chapters) || 0), 0);
    const prompt = `Tum ek expert study planner ho. Student ka naam: ${String(name || 'Student').slice(0, 40)}.
Exam me bache din: ${Number(days)}. Roz padhne ke ghante: ${Number(hours)}.
Subjects:
${list}
Total chapters: ${total}. Total available hours: ${Number(days) * Number(hours)}.

Hinglish me ek practical roadmap banao:
1. Short summary: total time, har subject ko kitna time (kathin/zyada chapters wale ko zyada)
2. Plan: agar 30 din ya kam hain to din-wise, warna week-wise plan jisme har din ka pattern ho (kaunsa subject/chapter aur kitne ghante)
3. Aakhri 15-20% time sirf revision aur mock test ke liye rakho
4. 4-5 practical tips

Rules: kisi din ke ghante roz ke limit se zyada mat rakho. Agar time bahut kam hai to saaf batao aur priority ke hisab se chapters chuno. Simple text me likho, markdown tables mat use karo.`;
    const out = await gemini([{ text: prompt }], false);
    return out.text ? res.status(200).json(out) : res.status(500).json(out);
  }

  /* ---------- PDF based: flashcards / quiz / summary ---------- */
  if (['flashcards', 'quiz', 'summary'].includes(b.mode)) {
    if (!b.pdf) return bad('PDF nahi mila');
    const pdfPart = { inline_data: { mime_type: 'application/pdf', data: b.pdf } };

    if (b.mode === 'flashcards') {
      const n = Math.min(80, Math.max(5, parseInt(b.count) || 25));
      const prompt = `Is chapter ke PDF se ${n} flashcards banao jo turant yaad karne me help karein. Bhasha: ${LANG}.
Sirf zaroori definitions, formulas, facts, dates, aur concepts lo. Har card chhota aur clear ho.
Sirf ye JSON array do, aur kuch nahi: [{"q":"sawal","a":"jawab"}]`;
      const out = await gemini([{ text: prompt }, pdfPart], true);
      if (!out.text) return res.status(500).json(out);
      try {
        const cards = parseJSON(out.text).filter(c => c && c.q && c.a);
        return res.status(200).json({ cards });
      } catch (e) {
        return res.status(500).json({ error: 'Flashcards samajh nahi aaye. Cards kam karke dobara try karo.' });
      }
    }

    if (b.mode === 'quiz') {
      const n = Math.min(30, Math.max(5, parseInt(b.count) || 10));
      const level = ['Aasan', 'Medium', 'Kathin'].includes(b.level) ? b.level : 'Medium';
      const prompt = `Is chapter ke PDF se ${n} MCQ (multiple choice) sawal banao. Bhasha: ${LANG}. Difficulty: ${level}.
Rules:
- Har sawal ke exactly 4 options ho, sirf ek sahi.
- Sahi option alag alag jagah (A, B, C, D) pe aaye, sab pehle option pe nahi.
- "a" me sahi option ka index do (0 se 3).
- "why" me 1-2 line ki chhoti explanation do.
- "topic" me us sawal ka chapter-topic 2-4 shabd me do (jaise "Newton ke niyam").
Sirf ye JSON array do, aur kuch nahi: [{"q":"sawal","o":["opt1","opt2","opt3","opt4"],"a":0,"why":"explanation","topic":"topic naam"}]`;
      const out = await gemini([{ text: prompt }, pdfPart], true);
      if (!out.text) return res.status(500).json(out);
      try {
        const quiz = parseJSON(out.text).filter(q => q && q.q && Array.isArray(q.o) && q.o.length === 4 && Number.isInteger(q.a) && q.a >= 0 && q.a <= 3);
        if (!quiz.length) throw new Error('empty');
        return res.status(200).json({ quiz });
      } catch (e) {
        return res.status(500).json({ error: 'Quiz samajh nahi aaya. Sawal kam karke dobara try karo.' });
      }
    }

    if (b.mode === 'summary') {
      const styles = {
        short: 'Chapter ka short summary do: 10-15 line ka summary, phir 5 sabse important points.',
        revision: 'Ye 5-minute revision notes banao: headings, chhote bullet points, zaroori formulas/definitions/dates, ek "Yaad rakho" section, aur aakhri me 5 self-check sawal (jawab ke bina).',
        simple: 'Chapter ko bahut simple bhasha me samjhao, jaise dost ko samjha rahe ho. Real-life examples do aur headings use karo.'
      };
      const style = styles[b.smode] || styles.revision;
      const prompt = `Is chapter ke PDF ko padho. ${style}
Bhasha: ${LANG}. Simple text me likho, markdown tables mat use karo. Headings ke liye "## Heading" aur points ke liye "- " use karo.`;
      const out = await gemini([{ text: prompt }, pdfPart], false);
      return out.text ? res.status(200).json(out) : res.status(500).json(out);
    }
  }

  /* ---------- DOUBT SOLVER ---------- */
  if (b.mode === 'doubt') {
    const images = Array.isArray(b.images) ? b.images.slice(0, 3) : [];
    const text = String(b.text || '').slice(0, 1500);
    if (!images.length && !text.trim()) return bad('Photo ya question daalo');
    const prompt = `Tum ek friendly aur patient teacher ho. Student ka doubt neeche photo aur/ya text me hai.
${text ? 'Student ne likha: ' + text : ''}
Bhasha: ${LANG}. Ye format follow karo:
## Question
(question ek line me)
## Steps
(step-by-step, har step chhota aur simple, "- " se shuru)
## Final Answer
(sahi answer)
## Yaad rakhne ki trick
(1-2 line ki trick ya concept)
Agar photo dhundhli hai ya question samajh nahi aaya to saaf bolo aur dobara saaf photo maango. Markdown tables mat use karo.`;
    const parts = [{ text: prompt }, ...images.map(d => ({ inline_data: { mime_type: 'image/jpeg', data: d } }))];
    const out = await gemini(parts, false);
    return out.text ? res.status(200).json(out) : res.status(500).json(out);
  }

  return bad('Galat request');
                                                                               }
