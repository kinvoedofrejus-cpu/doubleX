-- Migration à exécuter si tu as déjà initialisé la base avec l'ancien schema.sql
-- (si tu pars de zéro, schema.sql à jour suffit, ignore ce fichier)

ALTER TABLE deposits ADD COLUMN swept_at TEXT;
ALTER TABLE deposits ADD COLUMN swept_tx_hash TEXT;
