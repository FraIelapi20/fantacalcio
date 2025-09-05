import express from "express";
import pkg from "pg";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;
const app = express();
app.use(express.json());

// Serve file statici dalla cartella public
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// --- Connessione PostgreSQL ---

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT || 5432,
  ssl: {
    rejectUnauthorized: false // permette connessioni SSL senza certificato valido
  }
});


pool.connect()
  .then(() => console.log("✅ Connessione a PostgreSQL riuscita"))
  .catch(err => console.error("❌ Errore connessione PostgreSQL", err));

// --- API: Rose ---
app.get("/api/rose", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM rose");
    res.json(result.rows);
  } catch (err) {
    console.error("Errore /api/rose:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: Aggiungi formazione ---
// --- API: Aggiungi formazione ---
app.post("/api/formazioni", async (req, res) => {
  const { squadra, password, titolari, panchina } = req.body;

  if (password !== "1234") return res.status(403).json({ error: "Password errata" });

  try {
    // prendi ultima giornata registrata
    const gq = await pool.query("SELECT MAX(giornata) AS max FROM formazioni");
    let giornata = gq.rows[0].max || 1;

    // controlla se la giornata corrente è già stata calcolata
    if (gq.rows[0].max) {
      const check = await pool.query(
        "SELECT COUNT(*) FROM formazioni WHERE giornata = $1 AND calcolato = false",
        [giornata]
      );
      if (parseInt(check.rows[0].count) === 0) {
        // tutte calcolate → vai alla prossima giornata
        giornata = giornata + 1;
      }
    }

    // inserisci la formazione nella giornata determinata
    const query = `
      INSERT INTO formazioni (giornata, squadra, titolari, panchina, calcolato)
      VALUES ($1, $2, $3::json, $4::json, false)
      RETURNING *;
    `;

    const values = [
      giornata,
      squadra,
      JSON.stringify(titolari),
      JSON.stringify(panchina)
    ];

    const result = await pool.query(query, values);

    res.json({ ok: true, formazione: result.rows[0] });
  } catch (err) {
    console.error("Errore /api/formazioni:", err);
    res.status(500).json({ error: err.message });
  }
});


// --- API: Leggi tutte le formazioni ---
app.get("/api/formazioni", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM formazioni ORDER BY giornata, squadra");

    // Riorganizza i dati in giornate -> squadre
    const out = {};
    result.rows.forEach(r => {
      if (!out[r.giornata]) {
        out[r.giornata] = { squadre: {} };
      }
      out[r.giornata].squadre[r.squadra] = {
        titolari: r.titolari,
        panchina: r.panchina,
        voti: r.voti || {}
      };
    });

    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



// --- API: Classifica ---
app.get("/api/classifica", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM classifica ORDER BY punti DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("Errore /api/classifica:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Avvio ---
if (process.env.NODE_ENV !== "production") {
  const port = 3000;
  app.listen(port, () => console.log("Server avviato su http://localhost:" + port));
}

// --- API: Calcola giornata ---
// GET -> restituisce prossima giornata non calcolata con le formazioni
app.get("/api/calcola", async (req, res) => {
  try {
    // prendi la prossima giornata non calcolata (numero)
    const gq = await pool.query(
      "SELECT DISTINCT giornata FROM formazioni WHERE calcolato = false ORDER BY giornata ASC LIMIT 1"
    );
    if (!gq.rows.length) return res.json({ error: "Nessuna giornata da calcolare" });

    const giornata = gq.rows[0].giornata;

    // prendi tutte le formazioni per quella giornata
    const fRes = await pool.query(
      "SELECT id, squadra, titolari, panchina, voti FROM formazioni WHERE giornata = $1",
      [giornata]
    );

    // costruisci l'oggetto squadre come si aspetta il frontend
    const squadre = {};
    fRes.rows.forEach(r => {
      squadre[r.squadra] = {
        id: r.id,
        titolari: r.titolari || [],
        panchina: r.panchina || [],
        voti: r.voti || {}
      };
    });

    res.json({ giornata, squadre });
  } catch (err) {
    console.error("Errore GET /api/calcola:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST -> riceve { password, voti } dove voti = { "Squadra": { "giocatore": numero, ... }, ... }
// calcola i totali, aggiorna formazioni.voti e calcolato=true, aggiorna classifica
app.post("/api/calcola", async (req, res) => {
  const { password, voti } = req.body;
  if (password !== "1234") return res.status(403).json({ error: "Password errata" });

  try {
    // Determina la giornata corrente: quella non ancora calcolata
    const { rows: giornateNonCalcolate } = await pool.query(
      "SELECT DISTINCT giornata FROM formazioni WHERE calcolato = false ORDER BY giornata ASC LIMIT 1"
    );

    if (giornateNonCalcolate.length === 0)
      return res.json({ ok: false, message: "Nessuna giornata da calcolare" });

    const giornataCorrente = giornateNonCalcolate[0].giornata;

    // Aggiorna le formazioni della giornata corrente
    for (const [squadra, giocatori] of Object.entries(voti)) {
      await pool.query(
        `UPDATE formazioni
         SET voti = $1::json, calcolato = true
         WHERE squadra = $2 AND giornata = $3`,
        [JSON.stringify(giocatori), squadra, giornataCorrente]
      );

      // Somma punti cumulativa
      const punti = Object.values(giocatori).reduce((a, b) => a + b, 0);
      await pool.query(
        `INSERT INTO classifica (squadra, punti)
         VALUES ($1, $2)
         ON CONFLICT (squadra)
         DO UPDATE SET punti = classifica.punti + EXCLUDED.punti`,
        [squadra, punti]
      );
    }

    res.json({ ok: true, giornata: giornataCorrente, message: "Punteggi calcolati e sommati" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

export default app;
