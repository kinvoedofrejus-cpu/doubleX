-- Ajoute la colonne qui matérialise la fenêtre de délai avant qu'un retrait
-- approuvé ne soit réellement envoyé — te laisse le temps de le bloquer.
ALTER TABLE withdrawal_requests ADD COLUMN eligible_at TEXT;
