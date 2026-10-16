-- ============================================================================
-- PARCAUTO MAROC — SCHÉMA POSTGRESQL OFFICIEL (RAILWAY / SUPABASE / NEON / VPS)
-- Compatible à 100 % avec PostgreSQL standard (Railway) sans dépendance externe
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. TABLE DES COMPTES UTILISATEURS (Authentification native)
CREATE TABLE IF NOT EXISTS public.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2. TABLE DES AGENCES (Multi-tenant : 1 compte = 1 agence isolée)
CREATE TABLE IF NOT EXISTS public.agencies (
  id uuid PRIMARY KEY,
  owner_id uuid UNIQUE REFERENCES public.app_users(id) ON DELETE CASCADE,
  company text NOT NULL DEFAULT 'Mon Agence Auto',
  owner_name text NOT NULL DEFAULT 'Gérant',
  legal_name text DEFAULT '',
  ice text DEFAULT '',
  rc text DEFAULT '',
  city text DEFAULT 'Casablanca',
  address text DEFAULT '',
  phone text DEFAULT '',
  email text DEFAULT '',
  plan text NOT NULL DEFAULT 'pro',
  period text NOT NULL DEFAULT 'month',
  trial_days integer NOT NULL DEFAULT 14,
  subscription_ends_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  suspended boolean NOT NULL DEFAULT false,
  tva numeric(5,2) NOT NULL DEFAULT 20.00,
  rules_json jsonb,
  state_snapshot jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Migrations idempotentes si la table agencies existait déjà
ALTER TABLE public.agencies ADD COLUMN IF NOT EXISTS owner_name text NOT NULL DEFAULT 'Gérant';
ALTER TABLE public.agencies ADD COLUMN IF NOT EXISTS city text DEFAULT 'Casablanca';
ALTER TABLE public.agencies ADD COLUMN IF NOT EXISTS tva numeric(5,2) NOT NULL DEFAULT 20.00;
ALTER TABLE public.agencies ADD COLUMN IF NOT EXISTS rules_json jsonb;
ALTER TABLE public.agencies ADD COLUMN IF NOT EXISTS subscription_ends_at timestamptz NOT NULL DEFAULT (now() + interval '14 days');
ALTER TABLE public.agencies ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;

-- 3. TABLE DES VÉHICULES
CREATE TABLE IF NOT EXISTS public.vehicles (
  id text NOT NULL,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  plate text NOT NULL,
  brand text NOT NULL,
  model text NOT NULL,
  year integer NOT NULL DEFAULT 2026,
  color text DEFAULT '',
  fuel text DEFAULT 'Diesel',
  box text DEFAULT 'Manuelle',
  vin text DEFAULT '',
  km integer NOT NULL DEFAULT 0,
  buy_date date,
  buy_price numeric(12,2) DEFAULT 0,
  supplier text DEFAULT '',
  warranty_end date,
  daily_rate numeric(10,2) NOT NULL DEFAULT 250,
  status text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, id)
);

-- 4. TABLE DES DOCUMENTS ET ÉCHÉANCES (Assurance, Vignette, Visite technique, Carte grise)
CREATE TABLE IF NOT EXISTS public.vehicle_documents (
  id text NOT NULL,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  vid text NOT NULL,
  kind text NOT NULL,
  due_date date NOT NULL,
  org text DEFAULT '',
  cost numeric(10,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, id)
);

-- 5. TABLE DES CLIENTS LOCATAIRES
CREATE TABLE IF NOT EXISTS public.clients (
  id text NOT NULL,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NOT NULL,
  cin text NOT NULL,
  licence text NOT NULL,
  email text DEFAULT '',
  since_date date DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, id)
);

-- 6. TABLE DES CONTRATS DE LOCATION
CREATE TABLE IF NOT EXISTS public.rentals (
  id text NOT NULL,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  vid text NOT NULL,
  cid text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  daily_rate numeric(10,2) NOT NULL,
  deposit numeric(10,2) NOT NULL DEFAULT 3000,
  km_out integer NOT NULL DEFAULT 0,
  km_in integer,
  place text DEFAULT 'Agence Casablanca',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, id)
);

-- 7. TABLE DES MAINTENANCES & RÉPARATIONS ATELIER
CREATE TABLE IF NOT EXISTS public.maintenances (
  id text NOT NULL,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  vid text NOT NULL,
  maint_date date NOT NULL DEFAULT current_date,
  type text NOT NULL,
  description text DEFAULT '',
  cost numeric(10,2) NOT NULL DEFAULT 0,
  garage text DEFAULT '',
  km integer DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, id)
);

-- 8. TABLE DES SINISTRES & DOSSIERS D'ASSURANCE
CREATE TABLE IF NOT EXISTS public.claims (
  id text NOT NULL,
  agency_id uuid NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  vid text NOT NULL,
  claim_date date NOT NULL DEFAULT current_date,
  ref text NOT NULL,
  driver text DEFAULT '',
  place text DEFAULT '',
  responsibility text DEFAULT 'Tiers',
  damage text DEFAULT '',
  amount numeric(10,2) NOT NULL DEFAULT 0,
  insurer text DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, id)
);

-- 9. TABLE DES DEMANDES DE DÉMO / PROSPECTS
CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_name text NOT NULL,
  city text DEFAULT '',
  phone text NOT NULL,
  fleet_size text DEFAULT '',
  message text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 10. INDEX DE PERFORMANCE MULTI-AGENCES
CREATE INDEX IF NOT EXISTS idx_vehicles_agency ON public.vehicles(agency_id);
CREATE INDEX IF NOT EXISTS idx_docs_agency ON public.vehicle_documents(agency_id);
CREATE INDEX IF NOT EXISTS idx_clients_agency ON public.clients(agency_id);
CREATE INDEX IF NOT EXISTS idx_rentals_agency ON public.rentals(agency_id);
CREATE INDEX IF NOT EXISTS idx_maint_agency ON public.maintenances(agency_id);
CREATE INDEX IF NOT EXISTS idx_claims_agency ON public.claims(agency_id);

-- 11. FONCTION D'EXPIRATION AUTOMATIQUE DES ABONNEMENTS
CREATE OR REPLACE FUNCTION public.check_expired_agencies()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.agencies
  SET suspended = true,
      trial_days = 0
  WHERE subscription_ends_at < now() AND suspended = false;
END;
$$;
