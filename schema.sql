-- Plans de tontine créés par l'administrateur
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  amount_type TEXT NOT NULL CHECK (amount_type IN ('fixed', 'range')),
  amount_fixed REAL,
  amount_min REAL,
  amount_max REAL,
  duration_days INTEGER NOT NULL,
  gain_percent REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Utilisateurs Telegram
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  withdrawal_address TEXT,
  withdrawals_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- État de conversation (flux multi-étapes du bot, ex: saisie d'une adresse)
CREATE TABLE IF NOT EXISTS conversation_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  state TEXT NOT NULL,
  data TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Une adresse TRON générée par dépôt (une adresse unique par dépôt = suivi simple et fiable)
CREATE TABLE IF NOT EXISTS deposit_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tron_address TEXT UNIQUE NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dépôts (= "cotisations" individuelles de chaque utilisateur)
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  address_id INTEGER NOT NULL REFERENCES deposit_addresses(id),
  amount_expected REAL,
  amount_received REAL,
  deposit_tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_deposit' CHECK (
    status IN (
      'awaiting_deposit',   -- adresse générée, en attente du virement USDT
      'confirmed',          -- dépôt détecté on-chain, compte à rebours lancé
      'matured',            -- date de ramassage atteinte, retrait possible
      'withdrawal_pending', -- retrait demandé, en attente (auto ou validation admin)
      'withdrawal_approved',-- validé par l'admin (si au-dessus du seuil)
      'withdrawn',          -- fonds envoyés à l'utilisateur
      'rejected',           -- retrait refusé par l'admin
      'mismatched_amount',  -- montant reçu hors plan (fixe non respecté ou hors plage) : à régulariser manuellement
      'refunded'            -- montant erroné renvoyé à l'expéditeur par l'admin
    )
  ),
  confirmed_at TEXT,
  maturity_date TEXT,
  swept_at TEXT,
  swept_tx_hash TEXT,
  refund_tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Demandes de retrait
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deposit_id INTEGER NOT NULL REFERENCES deposits(id),
  amount REAL NOT NULL,
  destination_address TEXT NOT NULL,
  requires_admin_approval INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'sent', 'failed')
  ),
  tx_hash TEXT,
  notified_admin_at TEXT,
  eligible_at TEXT, -- date à partir de laquelle le retrait peut réellement être envoyé (fenêtre de blocage)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposit_addresses_address ON deposit_addresses(tron_address);
CREATE INDEX IF NOT EXISTS idx_withdrawal_status ON withdrawal_requests(status);

-- Verrou simple pour empêcher deux exécutions du cron de se chevaucher
-- (ex: si un passage dure plus longtemps que l'intervalle entre deux déclenchements)
CREATE TABLE IF NOT EXISTS cron_locks (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_at TEXT
);
INSERT OR IGNORE INTO cron_locks (id, locked_at) VALUES (1, NULL);

-- Messages envoyés par un utilisateur à l'admin depuis le bot ("Contacter un
-- administrateur") : relie le message transféré à l'admin à son expéditeur,
-- pour qu'une réponse ("reply" Telegram) reparte vers le bon utilisateur.
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

-- Journal des actions effectuées depuis l'espace admin (traçabilité)
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
