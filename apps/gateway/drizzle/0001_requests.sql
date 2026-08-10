CREATE TYPE "public"."request_status" AS ENUM('success', 'error');--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"api_key_id" uuid,
	"requested_model" text NOT NULL,
	"route" text,
	"provider" text,
	"model" text,
	"status" "request_status" NOT NULL,
	"error_code" text,
	"http_status" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"provider_calls" integer DEFAULT 0 NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"streamed" boolean DEFAULT false NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"estimated_cost_usd" numeric(20, 10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "requests_created_at_idx" ON "requests" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "requests_api_key_idx" ON "requests" USING btree ("api_key_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "requests_provider_idx" ON "requests" USING btree ("provider","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "requests_trace_idx" ON "requests" USING btree ("trace_id");