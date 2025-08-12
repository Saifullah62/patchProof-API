# Grafana Monitoring for SVD Auth

This document explains how to import and operate the Grafana dashboard for SVD authentication health, and how to enable alerting.

## Import the Dashboard

- File: `grafana/svd-dashboard.json`
- Datasource: Prometheus (uid/name: `Prometheus`)
- Time range: start with `Last 6 hours`.

After import, you should see:
- Key Performance Indicators row with:
  - Success Rate (%)
  - Error Rate (%)
  - Logins per Minute
- Time series for:
  - SVD Events (begin vs complete)
  - Failure Breakdown (invalid, expired, replayed, malleable_reject)
  - Challenge Age Quantiles (p50, p90, p99)

## Variables

- `kid` and `sha` are templated variables, allowing per-key and per-deploy filtering.
- Default is All. Use multi-select to compare cohorts.

## Prometheus Metrics (exposed by the API)

- Counters
  - `svd_begin_total{kid, sha}`
  - `svd_complete_total{kid, sha}`
  - `svd_invalid_total{kid, sha}`
  - `svd_expired_total{kid, sha}`
  - `svd_replayed_total{kid, sha}`
  - `svd_malleable_reject_total{kid, sha}`
- Histogram
  - `svd_challenge_age_seconds_bucket{kid, sha, le}`

Note: `sha` should be set to your deployment SHA (DEPLOY_SHA) if your metrics integration includes it.

## KPIs

- Success Rate (%) = rate(complete) / rate(begin) * 100
- Error Rate (%) = (rate(begin) - rate(complete)) / rate(begin) * 100
- Logins/min = rate(begin) * 60
- Failure Breakdown = stacked view of invalid/expired/replayed/malleable_reject
- Challenge Age p99 should stay well below the challenge expiry time.

## Built-in Alerts

The dashboard includes a Grafana-managed alert example:
- High Rate of Invalid SVD Signatures: `sum(rate(svd_invalid_total[5m])) by (kid) > 0.1` for 5m

We recommend adding alerts for:
- Success Rate below 99% for 5 minutes
- Error Rate above 5% for 5 minutes
- Challenge Age p99 near expiry (e.g., > 80% of expiry window)
- Spikes in `svd_expired_total` or `svd_replayed_total`

Wire Grafana to your notification channels (PagerDuty/Slack/Email) in the Alerting UI.

## Dependency Monitoring (Recommended)

Add panels for critical dependencies to explain SVD failures:
- MongoDB
  - Connection errors (application logs to Prometheus via log exporter)
  - Operation latency and errors (if you export Mongo metrics)
- Redis (if configured for rate-limiting)
  - Redis availability and latency

Even without native exporters, correlate application error logs (e.g., Winston->Loki/ELK) with the SVD metrics using common labels like `DEPLOY_SHA`.

## Optional: UTXO Observability
  
If you export UTXO pool metrics, we recommend segmenting by the persisted `keyIdentifier` so you can compare pools across controllers:
  
- Example metrics (names are illustrative):
  - `utxo_available_count{keyIdentifier}`
  - `utxo_locked_count{keyIdentifier}`
  - `utxo_spent_total{keyIdentifier}`
  - `utxo_satoshis_sum{keyIdentifier, status}`
- Create a `keyIdentifier` templated variable with a query like `label_values(utxo_available_count, keyIdentifier)`.
- Add panels to visualize pool health and trends by `keyIdentifier`.
  
Note: The application does not ship UTXO Prometheus metrics by default. If you add them, ensure no sensitive material is exposed; `keyIdentifier` is public key material and safe to label.
