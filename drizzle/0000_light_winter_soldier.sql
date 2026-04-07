CREATE TYPE "public"."chain" AS ENUM('solana', 'base', 'ethereum');--> statement-breakpoint
CREATE TYPE "public"."fund_status" AS ENUM('created', 'configuring', 'active', 'divesting', 'distributing', 'completed', 'paused', 'failed');--> statement-breakpoint
CREATE TYPE "public"."operation" AS ENUM('fee_claim', 'swap', 'bridge_send', 'bridge_receive', 'bskt_create', 'bskt_rebalance', 'bskt_redeem', 'bskt_contribute', 'distribution');--> statement-breakpoint
CREATE TYPE "public"."pipeline_phase" AS ENUM('claiming', 'swapping', 'bridging', 'investing', 'divesting', 'distributing');--> statement-breakpoint
CREATE TABLE "fund_divestment_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"holder_split_bps" integer NOT NULL,
	"owner_split_bps" integer NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_params" jsonb NOT NULL,
	"distribution_currency" text NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "fund_divestment_config_fund_id_unique" UNIQUE("fund_id")
);
--> statement-breakpoint
CREATE TABLE "fund_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"chain" "chain" NOT NULL,
	"address" text NOT NULL,
	"wallet_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "funds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_mint" text NOT NULL,
	"creator_wallet" text NOT NULL,
	"status" "fund_status" DEFAULT 'created' NOT NULL,
	"target_chain" "chain" NOT NULL,
	"protocol_fee_bps" integer NOT NULL,
	"bskt_address" text,
	"accumulation_threshold_lamports" text DEFAULT '5000000000' NOT NULL,
	"last_pipeline_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"phase" "pipeline_phase" NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"pipeline_run_id" uuid,
	"chain" "chain" NOT NULL,
	"tx_hash" text NOT NULL,
	"operation" "operation" NOT NULL,
	"amount" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fund_divestment_config" ADD CONSTRAINT "fund_divestment_config_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_wallets" ADD CONSTRAINT "fund_wallets_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;