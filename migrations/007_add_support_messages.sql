-- Migration à exécuter si ta base D1 existait déjà avant l'ajout du contact admin.
-- Permet de relier chaque message transféré à l'admin à l'utilisateur qui l'a
-- envoyé, pour que la réponse (par "reply" Telegram) reparte au bon endroit.

CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  user_chat_id INTEGER NOT NULL,
  admin_chat_id INTEGER NOT NULL,
  admin_message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_support_messages_admin_msg
  ON support_messages(admin_chat_id, admin_message_id);
