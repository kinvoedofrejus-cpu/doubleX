-- Migration à exécuter si ta base D1 existait déjà avant l'ajout des paramètres utilisateur.

ALTER TABLE users ADD COLUMN withdrawal_address TEXT;

CREATE TABLE IF NOT EXISTS conversation_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  state TEXT NOT NULL,
  data TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
