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
  let auth = false
  if(squadra == "Kira team" && password == "TommasoAstorino0406" ) auth = true;
  if(squadra == "AC TUA" && password == "NinoDiaco1110" ) auth = true;
  if(squadra == "FC Paulo Team" && password == "Sky2207" ) auth = true;
  if(squadra == "i compagni del secolo" && password == "RenatoRiccardo11" ) auth = true;
  if(squadra == "Horto Muso" && password == "Yyynnniii" ) auth = true;
  if(squadra == "Macelleria Gioielleria" && password == "PasqualeMiletta2001" ) auth = true;
  if(squadra == "Magola UtD" && password == "GiacintoSimoneMagola" ) auth = true;
  if(squadra == "PakiGio 2125" && password == "Silvestro2105" ) auth = true;
  if(squadra == "rufy team fc" && password == "Roberto1910" ) auth = true;
  if(squadra == "SCOOBY GUD fc" && password == "SonettoMaggisano1234" ) auth = true;

  if (!auth) return res.status(403).json({ error: "Password errata" });

  try {
    // prendi ultima giornata registrata
    const gq = await pool.query("SELECT MAX(giornata) AS max FROM formazioni");
    let giornata = gq.rows[0].max || 1;
    const giornataRes = await pool.query(
        "SELECT locked FROM formazioni WHERE giornata = $1",
        [giornata]
      );

      if (giornataRes.rows[0]?.locked) {
        return res.status(403).json({ error: "Partite iniziate. Non puoi inserire la formazione." });
      }
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

    // Prova a fare UPDATE prima
    const updateRes = await pool.query(
      `UPDATE formazioni
       SET titolari = $1::json, panchina = $2::json
       WHERE squadra = $3 AND giornata = $4
       RETURNING *`,
      [JSON.stringify(titolari), JSON.stringify(panchina), squadra, giornata]
    );

    if (updateRes.rowCount > 0) {
      // Formazione aggiornata
      res.json({ ok: true, formazione: updateRes.rows[0], updated: true });
    } else {
      // Se non esiste, inserisci nuova riga
      const insertRes = await pool.query(
        `INSERT INTO formazioni (giornata, squadra, titolari, panchina, calcolato)
         VALUES ($1, $2, $3::json, $4::json, false)
         RETURNING *`,
        [giornata, squadra, JSON.stringify(titolari), JSON.stringify(panchina)]
      );
      res.json({ ok: true, formazione: insertRes.rows[0], updated: false });
    }
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
  if (password !== "Yyynnniii") return res.status(403).json({ error: "Password errata" });

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

      // Somma punti cumulativa corretta con decimali
      const punti = Object.values(giocatori)
        .map(v => parseFloat(v))
        .reduce((a, b) => a + b, 0);

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

app.post("/api/lock-giornata", async (req, res) => {
  const { password, giornata, locked } = req.body;
  if (password !== "Yyynnniii") return res.status(403).json({ error: "Password errata" });

  try {
    await pool.query(
      "UPDATE formazioni SET locked = $1 WHERE giornata = $2",
      [locked, giornata]
    );
    res.json({ ok: true, message: `Giornata ${giornata} ${locked ? "bloccata" : "sbloccata"}` });
  } catch (err) {
    console.error("Errore lock-giornata:", err);
    res.status(500).json({ error: err.message });
  }
});

// API Admin - Aggiorna quotazioni rose
app.post("/api/admin/aggiorna-quotazioni", async (req, res) => {
  const { password } = req.body;
  if (password !== "Yyynnniii") return res.status(403).json({ error: "Password errata" });

  try {
    const roseRes = await pool.query("SELECT * FROM rose");
    let aggiornate = 0;
    
    for (const rosa of roseRes.rows) {
      let giocatori = [];
      try {
        const giocatoriText = rosa.giocatori || '[]';
        const cleanText = giocatoriText.replace(/\]\[/g, ',').replace(/^\[+/, '[').replace(/\]+$/, ']');
        giocatori = JSON.parse(cleanText);
      } catch (e) {
        continue;
      }
      
      // Aggiorna quotazioni per ogni giocatore
      for (let g of giocatori) {
        const quotazioneRes = await pool.query("SELECT qa FROM giocatori WHERE nome ILIKE $1", [g.nome]);
        if (quotazioneRes.rows.length && quotazioneRes.rows[0].qa) {
          g.quotazione = quotazioneRes.rows[0].qa;
        }
      }
      
      // Salva rosa aggiornata
      await pool.query(
        "UPDATE rose SET giocatori = $1 WHERE id = $2",
        [JSON.stringify(giocatori), rosa.id]
      );
      aggiornate++;
    }
    
    res.json({ ok: true, message: `Aggiornate ${aggiornate} rose con le quotazioni attuali` });
  } catch (err) {
    console.error("Errore aggiorna-quotazioni:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/giocatori", async (req, res) => {
  const { search } = req.query;
  let query = "SELECT * FROM giocatori ORDER BY ruolo, nome";
  let params = [];
  if (search) {
    query = "SELECT * FROM giocatori WHERE nome ILIKE $1 ORDER BY ruolo, nome";
    params = [`%${search}%`];
  }
  const result = await pool.query(query, params);
  res.json(result.rows);
});

// API Mercato - Carica rosa squadra
app.post("/api/mercato/rosa", async (req, res) => {
  const { squadra, password } = req.body;
  let auth = false;
  if(squadra == "Kira team" && password == "TommasoAstorino0406" ) auth = true;
  if(squadra == "AC TUA" && password == "NinoDiaco1110" ) auth = true;
  if(squadra == "FC Paulo Team" && password == "Sky2207" ) auth = true;
  if(squadra == "i compagni del secolo" && password == "RenatoRiccardo11" ) auth = true;
  if(squadra == "Horto Muso" && password == "Yyynnniii" ) auth = true;
  if(squadra == "Macelleria Gioielleria" && password == "PasqualeMiletta2001" ) auth = true;
  if(squadra == "Magola UtD" && password == "GiacintoSimoneMagola" ) auth = true;
  if(squadra == "PakiGio 2125" && password == "Silvestro2105" ) auth = true;
  if(squadra == "rufy team fc" && password == "Roberto1910" ) auth = true;
  if(squadra == "SCOOBY GUD fc" && password == "SonettoMaggisano1234" ) auth = true;

  if (!auth) return res.status(403).json({ error: "Password errata" });

  try {
    const rosaRes = await pool.query("SELECT * FROM rose WHERE squadra = $1", [squadra]);
    if (!rosaRes.rows.length) return res.status(404).json({ error: "Rosa non trovata" });
    
    const rosa = rosaRes.rows[0];
    let giocatori = [];
    try {
      const giocatoriText = rosa.giocatori || '[]';
      // Rimuovi duplicati se presenti
      const cleanText = giocatoriText.replace(/\]\[/g, ',').replace(/^\[+/, '[').replace(/\]+$/, ']');
      giocatori = JSON.parse(cleanText);
    } catch (e) {
      giocatori = [];
    }
    
    // Aggiungi dettagli da tabella giocatori
    for (let g of giocatori) {
      const dettagli = await pool.query("SELECT ruolo, squadra FROM giocatori WHERE nome = $1", [g.nome]);
      if (dettagli.rows.length) {
        g.ruolo = dettagli.rows[0].ruolo;
        g.squadra = dettagli.rows[0].squadra;
      }
    }
    
    res.json({ crediti: parseInt(rosa.crediti) || 0, giocatori });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API Mercato - Svincola giocatore
app.post("/api/mercato/svincola", async (req, res) => {
  const { squadra, password, giocatore, quotazione } = req.body;
  let auth = false;
  if(squadra == "Kira team" && password == "TommasoAstorino0406" ) auth = true;
  if(squadra == "AC TUA" && password == "NinoDiaco1110" ) auth = true;
  if(squadra == "FC Paulo Team" && password == "Sky2207" ) auth = true;
  if(squadra == "i compagni del secolo" && password == "RenatoRiccardo11" ) auth = true;
  if(squadra == "Horto Muso" && password == "Yyynnniii" ) auth = true;
  if(squadra == "Macelleria Gioielleria" && password == "PasqualeMiletta2001" ) auth = true;
  if(squadra == "Magola UtD" && password == "GiacintoSimoneMagola" ) auth = true;
  if(squadra == "PakiGio 2125" && password == "Silvestro2105" ) auth = true;
  if(squadra == "rufy team fc" && password == "Roberto1910" ) auth = true;
  if(squadra == "SCOOBY GUD fc" && password == "SonettoMaggisano1234" ) auth = true;

  if (!auth) return res.status(403).json({ error: "Password errata" });

  try {
    const rosaRes = await pool.query("SELECT * FROM rose WHERE squadra = $1", [squadra]);
    if (!rosaRes.rows.length) return res.status(404).json({ error: "Rosa non trovata" });
    
    const rosa = rosaRes.rows[0];
    let giocatori = [];
    try {
      const giocatoriText = rosa.giocatori || '[]';
      const cleanText = giocatoriText.replace(/\]\[/g, ',').replace(/^\[+/, '[').replace(/\]+$/, ']');
      giocatori = JSON.parse(cleanText);
    } catch (e) {
      giocatori = [];
    }
    
    // Rimuovi giocatore dalla rosa
    const nuoviGiocatori = giocatori.filter(g => g.nome !== giocatore);
    const nuoviCrediti = parseInt(rosa.crediti) + quotazione;
    
    await pool.query(
      "UPDATE rose SET giocatori = $1, crediti = $2 WHERE squadra = $3",
      [JSON.stringify(nuoviGiocatori), nuoviCrediti.toString(), squadra]
    );
    
    res.json({ ok: true, nuoviCrediti });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



export default app;
