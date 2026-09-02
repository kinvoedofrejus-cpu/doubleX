-- Migration à exécuter si ta base D1 existait déjà avant l'ajout du blocage par utilisateur.

ALTER TABLE users ADD COLUMN withdrawals_blocked INTEGER NOT NULL DEFAULT 0;
