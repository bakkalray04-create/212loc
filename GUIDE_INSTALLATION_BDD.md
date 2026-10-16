# Guide d'installation de la Base de Données & Mise en ligne officielle — ParcAuto

Ce pack contient tout le nécessaire pour publier **ParcAuto** officiellement avec une vraie base de données PostgreSQL hébergée sur **Supabase** :

1. `index.html` : Votre application complète (Site vitrine public + Logiciel de gestion de parc auto FR/AR + Connecteur PostgreSQL/Supabase intégré).
2. `schema_supabase.sql` : Le script SQL complet qui crée les 8 tables relationnelles et la sécurité multi-agences (Row-Level Security).

---

## Étape 1 : Créer la base de données PostgreSQL gratuite sur Supabase (3 minutes)

1. Rendez-vous sur [https://supabase.com](https://supabase.com) et créez un compte gratuit.
2. Cliquez sur **New Project**, donnez-lui le nom `ParcAuto` et choisissez un mot de passe de base de données.
3. Une fois le projet prêt (environ 1 minute), cliquez dans le menu de gauche sur **SQL Editor** puis sur **New Query**.
4. Ouvrez le fichier `schema_supabase.sql` fourni dans ce dossier, copiez tout son contenu, collez-le dans l'éditeur SQL de Supabase, puis cliquez sur **Run**.
   - Les 8 tables sont automatiquement créées :
     - `agencies` (comptes des agences de location, paramètres légaux ICE/RC, formule d'abonnement)
     - `vehicles` (parc automobile de chaque agence)
     - `vehicle_documents` (assurances, vignettes, visites techniques, cartes grises)
     - `clients` (fichier clients CIN, permis, téléphone)
     - `rentals` (contrats de location, dates, tarifs, cautions, kilométrages)
     - `maintenances` (interventions atelier et coûts)
     - `claims` (sinistres et dossiers d'assurance)
     - `leads` (prospects qui demandent une démo ou un devis sur votre page publique)

---

## Étape 2 : Connecter `ParcAuto` à votre base Supabase

1. Dans votre tableau de bord Supabase, allez dans **Project Settings (⚙️) → API**.
2. Copiez deux informations :
   - **Project URL** (ex. `https://xyzcompany.supabase.co`)
   - **Project API Keys → `anon` `public`** (clé commençant par `eyJ...`)
3. Vous avez deux façons de les intégrer :
   - **Depuis l'interface de l'application** : ouvrez ParcAuto, cliquez sur **Base de données** en haut à droite (ou dans **Paramètres → Base de données Cloud**), collez votre `Project URL` et votre `Anon Key`, puis cliquez sur **Connecter & Synchroniser**.
   - **Directement dans le code avant de publier (`index.html`)** : cherchez `const DB = {` dans `index.html` et collez votre URL et votre clé dans `url: '...'` et `key: '...'` pour que tous vos visiteurs et agences clientes soient automatiquement connectés à votre serveur !

---

## Étape 3 : Publier le site officiellement sur Internet (2 minutes)

### Option A — Hébergement gratuit et instantané avec Netlify Drop ou Vercel
1. Allez sur [https://app.netlify.com/drop](https://app.netlify.com/drop) (ou sur Vercel).
2. Glissez-déposez le dossier contenant `index.html`.
3. Votre site est immédiatement en ligne en HTTPS (`https://...`). Vous pouvez ensuite y relier votre nom de domaine officiel (ex. `parcauto.ma`).

### Option B — Hébergement marocain avec nom de domaine `.ma` (Genious, Nindohost, Hostino, CapConnect)
1. Prenez votre nom de domaine `.ma` et un pack d'hébergement web cPanel.
2. Ouvrez le **Gestionnaire de fichiers (File Manager)** dans `public_html/`.
3. Importez le fichier `index.html`. Votre plateforme est immédiatement accessible sur votre domaine !
