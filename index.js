const path = require("path");
const express = require("express");
const oracledb = require("oracledb");
const fs = require("fs");
const csvWriter = require("csv-writer").createObjectCsvWriter;
const methodOverride = require('method-override'); // Ajouter cette ligne
const app = express();

// Définir EJS comme moteur de vue
app.set("view engine", "ejs");

// Définir le répertoire où se trouvent les fichiers HTML (vues)
app.set("views", path.join(__dirname, "views"));

// Optionnel : définir un répertoire pour les fichiers statiques (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));

// Middleware pour gérer les méthodes PUT et DELETE
app.use(methodOverride('_method')); // Ajouter cette ligne

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Middleware pour gérer les données des formulaires

// Définir le format de sortie pour OracleDB
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let connection;

async function connectToDatabase() {
  try {
    connection = await oracledb.getConnection({
      user: "admin",
      password: "password",
      connectionString: "0.0.0.0:1521/XEPDB1",
    });
    console.log("Successfully connected to Oracle Database");
  } catch (err) {
    console.error(err);
  }
}

async function setupDatabase() {
  // Remove old tables, dev only.
  await connection.execute(
    `BEGIN
    execute immediate 'drop table users CASCADE CONSTRAINTS';
    execute immediate 'drop table accounts CASCADE CONSTRAINTS';
    execute immediate 'drop table transactions CASCADE CONSTRAINTS';
    exception when others then if sqlcode <> -942 then raise; end if;
    END;`
  );

  // Create new tables, dev only.
  await connection.execute(
    `create table users (
      id number generated always as identity,
      name varchar2(256),
      email varchar2(512),
      creation_ts timestamp with time zone default current_timestamp,
      accounts number default 0,
      primary key (id)
    )`
  );

  await connection.execute(
    `create table accounts (
      id number generated always as identity,
      name varchar2(256),
      amount number,
      user_id number,
      CONSTRAINT fk_user
        FOREIGN KEY (user_id)
        REFERENCES users(id),
      transactions number default 0,
      creation_ts timestamp with time zone default current_timestamp,
      primary key (id)
    )`
  );

  await connection.execute(
    `create table transactions (
      id number generated always as identity,
      name varchar2(256),
      amount number,
      type number, -- 0: Out, 1: In
      account_id number,
      CONSTRAINT fk_account
        FOREIGN KEY (account_id)
        REFERENCES accounts(id),
      creation_ts timestamp with time zone default current_timestamp,
      primary key (id)
    )`
  );

  // Créer ou remplacer la procédure pour insérer un utilisateur
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_user (
      p_user_name IN users.name%TYPE,
      p_user_email IN users.email%TYPE,
      p_user_id OUT users.id%TYPE
    ) AS
    BEGIN
      INSERT INTO users (name, email)
      VALUES (p_user_name, p_user_email)
      RETURNING id INTO p_user_id;
    END;`
  );

  // Créer ou remplacer la procédure pour insérer un compte
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_account (
        p_account_name IN accounts.name%TYPE,
        p_amount IN accounts.amount%TYPE,
        p_user_id IN accounts.user_id%TYPE,
        p_account_id OUT accounts.id%TYPE
    ) AS
    BEGIN
        INSERT INTO accounts (name, amount, user_id)
        VALUES (p_account_name, p_amount, p_user_id)
        RETURNING id INTO p_account_id;

        UPDATE users
        SET accounts = accounts + 1
        WHERE id = p_user_id;
    END;`
  );

  // Créer ou remplacer la fonction pour formater le nom de la transaction
  await connection.execute(
    `CREATE OR REPLACE FUNCTION format_transaction_name (
        p_name IN VARCHAR2,
        p_type IN NUMBER
    ) RETURN VARCHAR2 AS
    BEGIN
        RETURN 'T' || p_type || '-' || UPPER(p_name);
    END;`
  );

  // Créer ou remplacer la procédure pour insérer une transaction
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_transaction (
        p_trans_name IN transactions.name%TYPE,
        p_amount IN transactions.amount%TYPE,
        p_type IN transactions.type%TYPE,
        p_account_id IN transactions.account_id%TYPE,
        p_trans_id OUT transactions.id%TYPE
    ) AS
    BEGIN
        INSERT INTO transactions (name, amount, type, account_id)
        VALUES (format_transaction_name(p_trans_name, p_type), p_amount, p_type, p_account_id)
        RETURNING id INTO p_trans_id;

        UPDATE accounts
        SET amount = amount + (CASE WHEN p_type = 1 THEN p_amount ELSE -p_amount END),
            transactions = transactions + 1
        WHERE id = p_account_id;
    END;`
  );

  // Créer le trigger pour mettre à jour le montant du compte
  await connection.execute(`
    CREATE OR REPLACE TRIGGER trg_update_account_balance
    AFTER INSERT OR UPDATE OR DELETE ON transactions
    FOR EACH ROW
    DECLARE
      v_amount_change NUMBER;
    BEGIN
      -- Déterminer le changement de montant en fonction de l'opération
      IF INSERTING THEN
        v_amount_change := :NEW.amount * CASE WHEN :NEW.type = 1 THEN 1 ELSE -1 END;
      ELSIF UPDATING THEN
        v_amount_change := (:NEW.amount - :OLD.amount) * CASE WHEN :NEW.type = 1 THEN 1 ELSE -1 END;
      ELSIF DELETING THEN
        v_amount_change := :OLD.amount * CASE WHEN :OLD.type = 1 THEN -1 ELSE 1 END;
      END IF;

      -- Mettre à jour le montant du compte
      UPDATE accounts
      SET amount = amount + v_amount_change
      WHERE id = :NEW.account_id;
    END;
  `);

  // Insert some data
  const usersSql = `insert into users (name, email, accounts) values(:1, :2, :3)`;
  const usersRows = [
    ["Valentin Montagne", "contact@vm-it-consulting.com", 2],
    ["Amélie Dal", "amelie.dal@gmail.com", 1],
    ["John Doe", "john.doe@example.com", 1],
    ["Jane Smith", "jane.smith@example.com", 0],
  ];
  let usersResult = await connection.executeMany(usersSql, usersRows);
  console.log(usersResult.rowsAffected, "Users rows inserted");

  const accountsSql = `insert into accounts (name, amount, user_id) values(:1, :2, :3)`;
  const accountsRows = [
    ["Compte courant", 2000, 1],
    ["Livret A", 13000, 1],
    ["Compte courant", 2500, 2],
    ["Compte épargne", 5000, 3],
  ];
  let accountsResult = await connection.executeMany(accountsSql, accountsRows);
  console.log(accountsResult.rowsAffected, "Accounts rows inserted");

  const transactionsSql = `insert into transactions (name, amount, type, account_id) values(:1, :2, :3, :4)`;
  const transactionsRows = [
    ["Salaire", 1500, 1, 1],
    ["Achat", -500, 0, 1],
    ["Achat", -2000, 0, 2],
    ["Dépôt", 3000, 1, 3],
  ];
  let transactionsResult = await connection.executeMany(transactionsSql, transactionsRows);
  console.log(transactionsResult.rowsAffected, "Transactions rows inserted");

  connection.commit(); // Now query the rows back
}

app.get("/", async (req, res) => {
  res.render("index"); // Assurez-vous d'avoir un fichier "index.ejs" dans le répertoire "views"
});

// Nouvelle route GET "/users"
app.get("/users", async (req, res) => {
  const getUsersSQL = `select * from users`;
  const result = await connection.execute(getUsersSQL);
  res.render("users", { users: result.rows });
});

// Route POST "/users" pour créer de nouveaux utilisateurs
app.post("/users", async (req, res) => {
  try {
    const createUserSQL = `BEGIN
          insert_user(:name, :email, :user_id);
        END;`;
    const result = await connection.execute(createUserSQL, {
      name: req.body.name,
      email: req.body.email,
      user_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });

    if (result.outBinds && result.outBinds.user_id) {
      res.redirect(`/accounts`);
    } else {
      res.status(500).send("Erreur lors de la création de l'utilisateur");
    }
  } catch (err) {
    console.error("Erreur lors de la création de l'utilisateur:", err);
    res.status(500).send("Erreur interne du serveur");
  }
});

app.get("/views/:userId", async (req, res) => {
  const getCurrentUserSQL = `select * from users where id = :1`;
  const getAccountsSQL = `select * from accounts where user_id = :1`;
  const [currentUser, accounts] = await Promise.all([
    connection.execute(getCurrentUserSQL, [req.params.userId]),
    connection.execute(getAccountsSQL, [req.params.userId]),
  ]);

  res.render("user-view", {
    currentUser: currentUser.rows[0],
    accounts: accounts.rows,
  });
});

// Nouvelle route GET "/views/:userId/:accountId" pour afficher les transactions d'un compte spécifique
app.get("/views/:userId/:accountId", async (req, res) => {
  const { userId, accountId } = req.params;
  const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id = :1`;
  const getAccountSQL = `SELECT * FROM accounts WHERE id = :1 AND user_id = :2`;
  const getUserSQL = `SELECT * FROM users WHERE id = :1`;

  try {
    const [transactions, account, user] = await Promise.all([
      connection.execute(getTransactionsSQL, [accountId]),
      connection.execute(getAccountSQL, [accountId, userId]),
      connection.execute(getUserSQL, [userId])
    ]);

    if (account.rows.length === 0) {
      return res.status(404).send("Compte non trouvé");
    }

    res.render("transactions", {
      transactions: transactions.rows,
      account: account.rows[0],
      user: user.rows[0]
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des transactions du compte:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Nouvelle route GET "/account/:accountId" pour afficher les détails d'un compte spécifique
app.get("/accounts/:accountId", async (req, res) => {
  const { accountId } = req.params;
  const getAccountSQL = `SELECT * FROM accounts WHERE id = :1`;
  const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id = :1`;

  try {
    const [account, transactions] = await Promise.all([
      connection.execute(getAccountSQL, [accountId]),
      connection.execute(getTransactionsSQL, [accountId]),
    ]);

    if (account.rows.length === 0) {
      return res.status(404).send("Compte non trouvé");
    }

    res.render("account", {
      account: account.rows[0],
      transactions: transactions.rows,
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des détails du compte:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Route GET "/accounts" pour renvoyer tous les comptes en JSON
app.get("/accounts", async (req, res) => {
  try {
    const getUsersSQL = `select * from users`;
    const getAccountsSQL = `select * from accounts`;
    const [usersResult, accountsResult] = await Promise.all([
      connection.execute(getUsersSQL),
      connection.execute(getAccountsSQL),
    ]);

    // Vérifiez si les résultats sont valides
    if (!usersResult || !accountsResult) {
      throw new Error("Failed to retrieve users or accounts");
    }

    res.render("accounts", {
      users: usersResult.rows,
      accounts: accountsResult.rows,
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des comptes:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Route POST "/accounts" pour créer de nouveaux comptes
app.post("/accounts", async (req, res) => {
  try {
    console.log("Tentative de création du compte avec les données : ", req.body);

    const createAccountSQL = `BEGIN
                insert_account(:name, :amount, :user_id, :account_id);
              END;`;
    const result = await connection.execute(createAccountSQL, {
      name: req.body.name,
      amount: req.body.amount,
      user_id: req.body.user_id,
      account_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });

    console.log("Résultat de l'insertion du compte : ", result);

    if (result && result.outBinds && result.outBinds.account_id) {
      console.log("Compte créé avec succès, ID du compte : ", result.outBinds.account_id[0]);
      await connection.commit(); // Engage la transaction
      res.redirect(`/accounts`);
    } else {
      console.log("Erreur lors de la création du compte, aucune ligne affectée");
      res.status(500).send("Erreur lors de la création du compte");
    }
  } catch (err) {
    console.error("Erreur lors de la création du compte:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Route GET "/transactions" pour afficher toutes les transactions
app.get("/transactions", async (req, res) => {
  try {
    const getTransactionsSQL = `select * from transactions`;
    const result = await connection.execute(getTransactionsSQL);

    if (!result) {
      throw new Error("Failed to retrieve transactions");
    }

    res.render("transactions", {
      transactions: result.rows
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des transactions:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Route POST "/transactions" pour créer de nouvelles transactions
app.post("/transactions", async (req, res) => {
  try {
    console.log("Tentative de création de la transaction avec les données : ", req.body);

    const createTransactionSQL = `BEGIN
                insert_transaction(:name, :amount, :type, :account_id, :trans_id);
              END;`;
    const result = await connection.execute(createTransactionSQL, {
      name: req.body.name,
      amount: req.body.amount,
      type: req.body.type,
      account_id: req.body.account_id,
      trans_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });

    console.log("Résultat de l'insertion de la transaction : ", result);

    if (result && result.outBinds && result.outBinds.trans_id) {
      console.log("Transaction créée avec succès, ID de la transaction : ", result.outBinds.trans_id[0]);
      await connection.commit(); // Engage la transaction
      res.redirect(`/views/${req.body.user_id}`);
    } else {
      console.log("Erreur lors de la création de la transaction, aucune ligne affectée");
      res.status(500).send("Erreur lors de la création de la transaction");
    }
  } catch (err) {
    console.error("Erreur lors de la création de la transaction:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Route PUT "/transactions/:id" pour mettre à jour une transaction existante
app.put("/transactions/:id", async (req, res) => {
  const { id } = req.params;
  const { name, amount, type, account_id } = req.body;

  if (!name || !amount || !type || !account_id) {
    return res.status(400).send("Tous les champs sont requis");
  }

  try {
    const updateTransactionSQL = `
      UPDATE transactions
      SET name = :name, amount = :amount, type = :type, account_id = :account_id
      WHERE id = :id
    `;
    const result = await connection.execute(updateTransactionSQL, {
      name,
      amount,
      type,
      account_id,
      id
    });

    if (result.rowsAffected && result.rowsAffected === 1) {
      await connection.commit();
      res.status(200).send("Transaction mise à jour avec succès");
    } else {
      res.status(404).send("Transaction non trouvée");
    }
  } catch (err) {
    console.error("Erreur lors de la mise à jour de la transaction:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Route DELETE "/transactions/:id" pour supprimer une transaction existante
app.delete("/transactions/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const deleteTransactionSQL = `
      DELETE FROM transactions
      WHERE id = :id
    `;
    const result = await connection.execute(deleteTransactionSQL, { id });

    if (result.rowsAffected && result.rowsAffected === 1) {
      await connection.commit();
      res.status(200).send("Transaction supprimée avec succès");
    } else {
      res.status(404).send("Transaction non trouvée");
    }
  } catch (err) {
    console.error("Erreur lors de la suppression de la transaction:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Route GET pour télécharger le fichier CSV
app.get("/accounts/:accountId/exports", async (req, res) => {
  const { accountId } = req.params;
  const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id = :1`;
  
  try {
    const result = await connection.execute(getTransactionsSQL, [accountId]);

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).send("Aucune transaction trouvée pour ce compte");
    }

    const csvFilePath = path.join(__dirname, `exports-account-${accountId}.csv`);
    const csvWriterInstance = csvWriter({
      path: csvFilePath,
      header: [
        { id: 'ID', title: 'ID' },
        { id: 'NAME', title: 'Nom' },
        { id: 'AMOUNT', title: 'Montant' },
        { id: 'TYPE', title: 'Type' },
        { id: 'ACCOUNT_ID', title: 'ID du Compte' },
        { id: 'CREATION_TS', title: 'Date de Création' }
      ]
    });

    await csvWriterInstance.writeRecords(result.rows);

    res.download(csvFilePath, `exports-account-${accountId}.csv`, (err) => {
      if (err) {
        console.error("Erreur lors du téléchargement du fichier CSV:", err.message);
        res.status(500).send("Erreur interne du serveur");
      }
      fs.unlink(csvFilePath, (err) => {
        if (err) {
          console.error("Erreur lors de la suppression du fichier CSV:", err.message);
        }
      });
    });
  } catch (err) {
    console.error("Erreur lors de l'export des transactions:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Route POST pour créer le fichier CSV
app.post("/accounts/:accountId/exports", async (req, res) => {
  const { accountId } = req.params;
  const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id = :1`;

  try {
    const result = await connection.execute(getTransactionsSQL, [accountId]);

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).send("Aucune transaction trouvée pour ce compte");
    }

    const csvFilePath = path.join(__dirname, `exports-account-${accountId}.csv`);
    const csvWriterInstance = csvWriter({
      path: csvFilePath,
      header: [
        { id: 'ID', title: 'ID' },
        { id: 'NAME', title: 'Nom' },
        { id: 'AMOUNT', title: 'Montant' },
        { id: 'TYPE', title: 'Type' },
        { id: 'ACCOUNT_ID', title: 'ID du Compte' },
        { id: 'CREATION_TS', title: 'Date de Création' }
      ]
    });

    await csvWriterInstance.writeRecords(result.rows);

    res.status(200).send(`Fichier CSV créé avec succès : exports-account-${accountId}.csv`);
  } catch (err) {
    console.error("Erreur lors de la création du fichier CSV:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

app.get("/accounts/:accountId/budgets/:amount", async (req, res) => {
  const { accountId, amount } = req.params;

  try {
    const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id = :1 ORDER BY creation_ts ASC`;
    const result = await connection.execute(getTransactionsSQL, [accountId]);

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).send("Aucune transaction trouvée pour ce compte");
    }

    let total = 0;
    let transactionsWithinBudget = [];

    for (const transaction of result.rows) {
      if (total + transaction.AMOUNT > amount) break;
      total += transaction.AMOUNT;
      transactionsWithinBudget.push(transaction);
    }

    res.render("budget", {
      accountId,
      budget: amount,
      transactions: transactionsWithinBudget
    });
  } catch (err) {
    console.error("Erreur lors de la récupération des transactions:", err.message);
    res.status(500).send("Erreur interne du serveur");
  }
});

// Connecter à la base de données puis démarrer le serveur
connectToDatabase()
  .then(async () => {
    await setupDatabase();
    app.listen(3000, () => {
      console.log("Server started on http://localhost:3000");
    });
  })
  .catch((err) => {
    console.error("Failed to connect to the database:", err);
  });
