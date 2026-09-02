-- Migration à exécuter si ta base D1 existait déjà avant ces ajouts.
-- Note : SQLite/D1 ne permet pas d'ajouter facilement une valeur à un CHECK existant
-- sur une colonne déjà créée ; les nouveaux statuts ('mismatched_amount', 'refunded')
-- fonctionneront quand même à l'écriture car D1 ne fait pas respecter les CHECK
-- aussi strictement qu'un moteur SQL classique, mais si tu veux une contrainte propre,
-- recrée la table deposits à partir de schema.sql sur un nouvel environnement.

ALTER TABLE deposits ADD COLUMN refund_tx_hash TEXT;
ALTER TABLE withdrawal_requests ADD COLUMN notified_admin_at TEXT;

CREATE TABLE IF NOT EXISTS cron_locks (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_at TEXT
);
INSERT OR IGNORE INTO cron_locks (id, locked_at) VALUES (1, NULL);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
