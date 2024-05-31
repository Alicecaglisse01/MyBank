const path = require("path");
const express = require("express");
const oracledb = require("oracledb");
const app = express();

// Définir EJS comme moteur de vue
app.set("view engine", "ejs");

// Définir le répertoire où se trouvent les fichiers HTML (vues)
app.set("views", path.join(__dirname, "views"));

// Optionnel : définir un répertoire pour les fichiers statiques (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));

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
        VALUES (p_trans_name, p_amount, p_type, p_account_id)
        RETURNING id INTO p_trans_id;

        UPDATE accounts
        SET amount = amount + (CASE WHEN p_type = 1 THEN p_amount ELSE -p_amount END),
            transactions = transactions + 1
        WHERE id = p_account_id;
    END;`
  );

  // Insert some data
  const usersSql = `insert into users (name, email, accounts) values(:1, :2, :3)`;
  const usersRows = [
    ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
    ["Amélie Dal", "amelie.dal@gmail.com", 0],
  ];
  let usersResult = await connection.executeMany(usersSql, usersRows);
  console.log(usersResult.rowsAffected, "Users rows inserted");

  const accountsSql = `insert into accounts (name, amount, user_id) values(:1, :2, :3)`;
  const accountsRows = [
    ["Compte courant", 2000, 1],
    ["Livret A", 13000, 1],
    ["Compte courant", 2500, 2],
  ];
  let accountsResult = await connection.executeMany(accountsSql, accountsRows);
  console.log(accountsResult.rowsAffected, "Accounts rows inserted");

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
