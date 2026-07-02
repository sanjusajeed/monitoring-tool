# App Publish & Start — Troubleshooting Playbook

> **Source-of-truth note**: this file is distilled from a one-time read of the Jiffy `app-manager` Go service (now removed from this repo). Keep it as the standing reference for diagnosing `am-publish-*` and `am-start-app-*` failures shown on the Monitoring Dashboard. Anything here that disagrees with newer app-manager behaviour wins for the older version; revisit if app-manager is upgraded.

---

## 1. What you're looking at

Two Temporal workflow families run in the **`default`** namespace and surface on our Dashboard's **"App publish & start failures"** card:

| Workflow ID prefix | Workflow type                          | What it does                                                           |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------- |
| `am-publish-*`     | `PublishAppWorkflow`                    | Publish a new app version: backup → call each mediator → restore on fail |
| `am-start-app-*`   | `DeployAndWaitToCompleteWorkflow`       | Start/deploy a published app: copy drive data → deploy → poll k8s        |

Both run in app-manager's worker. Both expose **live status** via Temporal queries (so you can read in-flight progress without waiting for the workflow to end):

* Publish query name: `publish-status` → `models.OperationStatus` with hierarchical step list
* Deploy query name: `am-deploy-undeploy-status` → `commonDm.DeploymentStatusResponse` with hierarchical step list

Both queries return the **current step's `Status`** (`Pending` / `InProgress` / `Completed` / `Failed`) and the **`Description`** (the error message when failed).

---

## 2. The publish flow — step by step

`PublishAppWorkflow(args PublishWorkflowArgs)` runs these activities in order. **The first one that fails is the root cause** (everything after it is skipped, except auto-rollback).

| # | Step                                       | Activity name                            | What it does                                                                       | Typical failures                                                                          |
| - | ------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 0 | Init query handler                         | (in-workflow)                            | Registers the `publish-status` query                                               | Almost never fails. If it does, the workflow returns immediately.                          |
| 1 | Cleanup leftover publish metadata in drive | `CleanupPublishMetadataInDrive`          | Best-effort cleanup of prior publish artefacts                                     | Errors are logged but not fatal.                                                          |
| 2 | **Call every mediator**                    | `InvokeMediatorActivity` (per mediator)  | The bulk of publish work. One activity per mediated component type (IAM, sandbox, jiffydrive, etc.) | **Most common failure point.** Mediator HTTP 5xx, mediator timeout, component not found, version mismatch. |
| 3 | Pre-publish: BackupApp                     | `BackupApp`                              | Snapshot the existing app rows / shared drive contents (for rollback)              | DB write failure, drive permission denied, drive quota.                                   |
| 4 | Pre-publish: UpdateModelRepoMediatedSvcs    | `UpdateModelRepoMediatedSvcsActivity`     | Bump the mediated services' versions in the model-repo                             | HTTP call to model-repo fails (500/timeout), DB lock.                                     |
| 5 | **PublishAppInWorkflow**                   | (in-workflow; calls `compPublishSvc`)    | The actual app rows + CLS publish + asset copy                                     | CLS API rejects (auth, payload schema), Postgres constraint violation, component missing. |
| 6 | (new apps only) MoveSharedDriveDataOnPublish | (in-workflow)                            | Promote `private/notReady` drive paths to the public published path                 | Drive copy failure → logged as error, **does NOT fail the workflow** (best effort).        |
| 7 | (new apps only) DeletePublicDriveForApp     | (in-workflow)                            | Remove temp public drive for the source app                                         | Logged, **does NOT fail the workflow**.                                                   |
| 8 | DeleteAppBackup                            | `DeleteAppBackup`                         | Clean up the backup taken at step 3                                                | Logged as WARN, **does NOT fail the workflow**.                                            |
| 9 | (not-IsNotReady only) postPublishAction     | `PostPublishActivity` or `EditAndDeployActivity` | If `PublishWithEdit=true`: trigger a deploy. Otherwise: delete the source app.    | DM deploy request rejected, source app delete fails.                                       |

**Auto-rollback on failure at step 5:**
1. `RevertUpdatedModelRepoMediatedSvcsActivity` — undo the model-repo version bump
2. `RestoreApp` — restore from the backup

If **rollback also fails**, both errors are joined into a single `svcerror.NewInternalErrorf("%s (restoring backup failed with err: %s)", origErr, restoreErr)` and surfaced via the publish-status query. This is the only place where the failure message contains a substring like `"restoring backup failed with err:"` — a strong signal that publish itself failed AND rollback failed (very bad state, likely needs manual intervention).

---

## 3. The start/deploy flow — step by step

`DeployAndWaitToCompleteWorkflow(args DeployUndeployWfArgs)` walks a fixed list of `DeployStep`s. Each step writes its own status into the `am-deploy-undeploy-status` query response.

| Step constant                       | What runs                                                    | Touches                            | Typical failures                                                              |
| ----------------------------------- | ------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------- |
| `DeployStepCopyDriveData`           | `CloneSharedDriveDataActivity` + `CopyDataFromGlobalDriveActivity` | App Sandbox Manager (ASM) HTTP API | ASM unavailable, drive auth / quota, source app not found.                    |
| `DeployStepUpgradeComponentModels`  | `UpgradeComponentModelsActivity`                              | model-repo HTTP API                | Component model version not found in CLS, model-repo 5xx, schema validation.   |
| `DeployStepStartDeploy`             | `StartDeployActivity` → calls Deployment Manager              | Deployment Manager (DM) HTTP API    | **`Deploy request on deployment manager failed`** — DM 5xx, k8s namespace missing, image pull. |
| `DeployStepUpradeAppUsingDm`        | `UpgradeAppUsingDomainModelActivity`                          | DM + domain-model service           | Domain-model service unavailable, schema migration failed.                    |
| (always last)                       | `WaitForDeployToCompleteActivity` — polls DM every 2 s        | DM HTTP API (poll loop)            | k8s pod CrashLoopBackOff, ImagePullBackOff, helm timeout, DM never reports done. |

The workflow **bails on the first failed step** (`if commonDm.IsFailedStatus(...): break`) so the failure-step name in the status query is the one to investigate.

On failure: `UpdateInstStateActivity` writes the final state (`StartFailed`) to the `app_inst_state` Postgres table. **No rollback** — deploy failure leaves the partial state in place.

---

## 4. Input payload field reference

When the AI investigation pulls the WorkflowExecutionStarted event's input payload, the relevant top-level fields are:

### `PublishAppWorkflow` input — `PublishWorkflowArgs`

```
Flags              { IsNotReady, IsNewApp, IsEditApp }
MediatedComponents [ ...one per service: IAM, sandbox, jiffydrive, ... ]
AppInst            { id (UUID), version, baseVersion, AppID, stageId, features, ... }
Env                { id, tenantId, name, ... }
EnvPartition       { id, name, nameSpace ("{env}-{tenant}"), appFqdnSuffix, ... }
App                { id, tenantId, name, displayName, description, namespace, urlPrefix, ... }
PublishInfo        { version, isHotfix, publishMessage, releaseNotes, namespace, AppLineage[] }
PublishWithEdit    bool   # if true, triggers deploy right after publish
AdditionalFields   { "p:platform-version": "..." }
```

### `DeployAndWaitToCompleteWorkflow` input — `DeployUndeployWfArgs` (embeds `DeployPayload`)

```
App                   { ...same as above }
DeployInst            { id, AppID, name, version, baseVersion, stageId, ... }
Env                   { ...same as above }
EnvPartition          { name, nameSpace, ... }
AppPublishedInCurrEnv bool
Operation             "start_app" | "stop_app" | "deploy" | "undeploy"
SourceAppInfo         { source clone info or component identity }
MediatedComponents    [ ... ]
IsDeployedOnce        bool   # outer wrapper field
```

### Tenant-name derivation (the Monitoring App does this; preserve the logic)

`tenant_name` is **not** in the payload directly — derive it from one of, in order:

1. `EnvPartition.nameSpace` — pattern `{env}-{tenant}` (e.g. `develop-democfo` → `democfo`)
2. `EnvPartition.appFqdnSuffix` — second dot-segment (e.g. `dev.democfo.wns-trac.jiffy.ai` → `democfo`)
3. fall back to the truncated `App.tenantId` UUID

---

## 5. Failure object shape

App-manager **does not** use Temporal's `temporal.NewApplicationError` / `temporal.NewNonRetryableApplicationError`. Errors are plain Go `fmt.Errorf` or `errors.New`. Temporal wraps them as default-retryable `ApplicationError`s. This means:

* The AI investigation **won't see a structured `errType`** field. The error message string is the only signal.
* Activities that return an error get **automatically retried by Temporal** (default policy: exponential backoff, infinite retries until activity timeout). So a "Failed" workflow status implies the activity timed out AFTER retries — the underlying problem persisted for a while.

Three error-text shapes to recognize:

| Shape                                                                              | Source                                          | Meaning                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `mediator <name> returned error on publish - <wrapped err>`                        | `mediator_workflow.go` `InvokeMediatorActivity` | A specific mediator call failed. The wrapped err is the mediator's HTTP/RPC error. |
| `Deploy request on deployment manager failed: <wrapped err>`                       | `deploy_svc.go` `StartDeployActivity`           | DM rejected the deploy request (k8s, auth, schema). |
| `failed to upgrade app component models (err: <wrapped err>)`                       | `deploy_svc.go` `UpgradeComponentModelsActivity` | model-repo or component-lookup failure.            |
| `<orig err> (restoring backup failed with err: <restore err>)`                     | publish rollback path                            | Publish failed AND rollback failed → manual fix.   |

---

## 6. Logging signals (OpenSearch field reference)

App-manager logs via **`go.uber.org/zap`** structured. These zap fields land in OpenSearch with the same names:

| OpenSearch field        | Constant in code           | Meaning                                                 |
| ----------------------- | -------------------------- | ------------------------------------------------------- |
| `appName`               | `FieldAppName`             | App slug (e.g. `reconciliation`)                        |
| `appInstId`             | `FieldAppInstId`           | App instance UUID — **the most reliable join key**       |
| `appId`                 | `FieldAppId`               | App UUID                                                |
| `tenantId`              | `FieldTenant`              | Tenant UUID                                             |
| `appVer`                | `FieldAppVer`              | App version (e.g. `28.45.1`)                            |
| `appBaseVer`            | `FieldAppBaseVer`          | Previous version (for diff)                             |
| `operation`             | `FieldOperation`           | One of `publish` / `deploy` / `predeploy` / `undeploy` / `delete` |
| `partition name`        | `FieldPartitionName`       | k8s namespace                                           |
| `component`             | `FieldComponent`           | Component object                                        |
| `comp name`             | `FieldCompName`            | Component name (e.g. `reconciliation-iam`)               |
| `comp id` / `comp ns` / `comp version` / `comp type` | `FieldComp*`               | Per-component identity                                  |
| `mediated service` / `mediated service name` / `mediated service type` | `MediatedSvc*Field`        | Which mediated service the log is about                 |
| `mediator`              | (zap.String("mediator", k)) | The mediator type (`iam`, `sandbox`, `jiffydrive`, etc.) |
| `stageName` / `stageId` | `LoggerFieldStage*`        | Pipeline stage                                          |
| `requestId`             | `FieldRequestId`           | HTTP request that triggered the action                  |

**To find every relevant log for a failed publish/start**, query OpenSearch (`platform-*` index pattern) with:

```
appInstId.keyword = "<the App Instance UUID from the payload's AppInst.id>"
AND level.keyword IN ("ERROR", "WARN")
AND @timestamp BETWEEN <workflow start> AND <workflow close + 1m>
```

`appInstId` is the strongest join key — it's set by app-manager, model-repo, deployment-manager, and all the mediator services, so a single query returns the cross-service story.

Pod-name patterns for these services (helpful when `appInstId` isn't on the doc):

* `app-manager-*` — the workflow orchestrator (most failure messages originate here)
* `app-sandbox-manager-*` — the ASM (for clone-drive failures)
* `deployment-manager-*` — DM (for `StartDeploy` and `WaitForDeploy` failures)
* `model-repo-*` — model registry (for "component not found", "version not found")
* `jiffydrive-*` — for drive-write failures during publish or copy steps

---

## 7. Diagnostic playbook (in order)

When the Dashboard's **App publish & start failures** card shows a failed workflow, follow these steps in the order written:

### Step 1 — Open the AI investigation (existing UI flow)

Click **Investigate** on the failed row. The Monitoring App calls `GET /api/temporal/investigate?workflow_id=<id>&namespace=default`. That endpoint:

1. Fetches the workflow's Temporal events (history).
2. Pulls OpenSearch logs in the failure window (now also follows ChildWorkflowFailure stack traces — see [conversation history], but those don't normally exist in publish/start chains because publish/start don't spawn Jiffy DSL children).
3. Decodes the input payload → extracts `App.displayName`, `EnvPartition.nameSpace`, etc. into the `appContext` field.
4. Sends everything to Claude for an RCA.

The modal shows: **Root cause** · **Failure chain** · **Resolution** · **Prevention**. For these workflows the chain typically ends at one of the steps in §2 or §3.

### Step 2 — Read the AI's "failure chain" against the step table

Map the AI's chain to **§2 (publish)** or **§3 (start/deploy)**. The chain should end at one of the named steps. If the AI guessed something not in those tables, treat it with skepticism — the workflow only takes the documented paths.

### Step 3 — If AI is unsure, query Temporal's live status directly

* **Publish**: `temporal workflow query --workflow-id <id> -t publish-status -n default`
* **Deploy**: `temporal workflow query --workflow-id <id> -t am-deploy-undeploy-status -n default`

The response is a JSON tree with a `Dependencies[]` array — find the entry whose `Status == "Failed"` and read its `Description` for the literal error message app-manager wrote.

### Step 4 — If still unclear, pull cross-service logs

In OpenSearch (Kibana / Discover), filter `platform-*` to:

```
appInstId : "<AppInst.id from the failure>"  AND  level : ("ERROR" or "WARN")
```

Time window: workflow `start_time − 30s` to `close_time + 1m`. This pulls logs from app-manager, ASM, DM, model-repo, jiffydrive all keyed on the same instance.

### Step 5 — Identify the failing service and apply the fix table

See §8 below.

---

## 8. Failure → likely cause → fix

| Symptom (in failure message / Description)                                                                | Likely cause                                                                                                  | Fix                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `mediator <iam\|sandbox\|jiffydrive\|...> returned error on publish - <500 / timeout>`                    | That mediator service is down, restarted mid-publish, or hit a Postgres deadlock                              | Check the mediator pod logs (`<mediator>-*`). Restart the pod if hung. Re-trigger publish once it's healthy.               |
| `mediator <name> returned error on publish - component '<X>' version '<Y>' not found`                     | The component version referenced doesn't exist in the model-repo / CLS                                         | Verify component exists at that version in `model-repo`. Republish the component first, or fix the version in `AppInst`.   |
| `failed to update mediated service`                                                                       | `UpdateModelRepoMediatedSvcsActivity` — model-repo HTTP failure                                                | Check `model-repo-*` pod health and DB. Retry once model-repo recovers.                                                    |
| `Deploy request on deployment manager failed: <k8s err>`                                                  | DM rejected the request before deploy even started — namespace doesn't exist, RBAC, image-pull, helm validation | Check `deployment-manager-*` logs. Validate the target k8s namespace exists. Confirm the container image is reachable.       |
| `failed to upgrade app component models (err: <err>)`                                                     | `UpgradeComponentModelsActivity` — model upgrade in the running k8s pod failed                                 | Check the component pod (`<comp-name>-*`) for migration errors. May need a manual DB migration before re-running deploy.   |
| Deploy hangs at `DeployStepStartDeploy` for >15 min                                                       | DM accepted the request but k8s never reaches Ready — CrashLoopBackOff, ImagePullBackOff, PVC unbound          | `kubectl get pods -n <EnvPartition.nameSpace> | grep <App.name>` — look for non-Running pods. Read pod events / container logs. |
| Publish error includes `(restoring backup failed with err: ...)`                                          | Original publish failed AND auto-rollback failed                                                              | **Manual intervention required.** App is in a half-published state. Restore from backup manually, or roll forward to a clean publish. |
| `failed to get app instance state` / `failed to get component from comp lib`                              | Postgres unavailable or the row is gone (race with delete)                                                     | Check Postgres health. If row missing, app-instance may have been deleted mid-workflow — coordinate with whoever did that.   |
| No mediator named in error; just `unable to find tenant for App '<X>'`                                    | Tenant lookup failed (PAM unreachable or tenant deleted)                                                       | Check PAM service health. Confirm `App.tenantId` still exists in the tenant table.                                          |
| Workflow status `Failed` but no Description in `publish-status` query                                     | Unhandled panic in app-manager process (very rare)                                                            | Check `app-manager-*` pod for panic stack trace at the workflow's `close_time`.                                            |

---

## 9. Worked example — `am-publish-07711571-f53c-496a-81cb-baafe610d9b2`

This is the workflow shown on the current Dashboard. Reference values pulled from `/investigate`:

* **App**: Reconciliation (`reconciliation`)
* **Tenant**: democfo (`a3824af1-a54c-4965-87af-d3d7813d1a5f`)
* **Env**: develop · namespace `develop-democfo`
* **AppInst ID**: `ae3005de-04f4-4d38-a707-4a46b7977ce4`  ← **use this in OpenSearch**
* **Versions**: publishing `28.46.0`, base `28.45.0`, AppInst at `28.45.1`
* **143 Temporal events**, status FAILED.
* **AI root cause**: "The PublishAppWorkflow failed because the 'reconciliation' component with version 28.45.1 of type 'application' does not exist in the component registry or deployment system."

**Mapping to this playbook**: matches §8 row 2 (`component '<X>' version '<Y>' not found`). The failing step is §2 step 5 (`PublishAppInWorkflow` → calls `compPublishSvc.PublishAppInWorkflow`) which couldn't resolve the app-component itself. The expected fix is to verify the `application` component at `28.45.1` exists in the model-repo; if not, republish that base component first.

**OpenSearch query to confirm** (paste into Kibana):

```
appInstId.keyword : "ae3005de-04f4-4d38-a707-4a46b7977ce4"
AND level.keyword : ("ERROR" OR "WARN")
AND @timestamp >= "2026-06-02T13:55:00Z" AND @timestamp <= "2026-06-02T13:57:00Z"
```

You should see `app-manager-*` and `model-repo-*` rows. The model-repo log will contain the literal lookup that returned 404 / not-found.

---

## 10. Worth knowing (other minor things)

* **Retries & timeouts**: app-manager doesn't override Temporal's default activity retry policy (exponential backoff, infinite retries). Activities use `utils.StartHeartbeat` to keep Temporal from marking them dead during long mediator calls. A `Failed` workflow status therefore implies activity timeout AFTER retries — the underlying problem held for >>1 minute.
* **Idempotency**: not enforced explicitly by `workflow_id`. A retry of the same publish version against the same app instance will re-create a new workflow ID. The "EditAndDeploy" path uses a deterministic-ish version bump, so back-to-back retries land on different versions.
* **Status enums on the Postgres side** (`app_inst_state.state`): `starting · started · startFailed · stopping · stopped · publishFailed · initialized · stopFailed · deleting · deleteFailed · deleted · NotStarted`.
* **Operation values** (`Operation` enum used in logs and DB): `publish · deploy · predeploy · undeploy · delete`.
* **Why `am-publish-*` workflows are in `default` namespace (not `JIFFY_LIVE`)**: app-manager runs separately from tenant workloads. Tenant workflows (the `Jiffy_*` / UUID-style ones we see on Tenants & Apps) live in `JIFFY_LIVE`. Always pass `?namespace=default` when calling `/api/temporal/investigate` for an `am-*` workflow ID.

---

## 11. When to upgrade this doc

Revisit this playbook if:

* App-manager adds a new `DeployStep` (the deploy switch in `DeployAndWaitToCompleteWorkflow` gets a new `case`).
* App-manager starts using `temporal.NewApplicationError` with custom `errType` codes — then §5 becomes obsolete and AI investigation can use the structured types directly.
* The list of mediators changes (today: IAM, sandbox, jiffydrive, etc.). The mediator names land in the `mediator` log field, so any new mediator should appear there first.
* Auto-rollback behaviour changes (publish currently rolls back on failure; deploy does not).

The standing source of truth was `app-manager/services/publish/publish_workflow.go`, `app-manager/services/publish/mediator_workflow.go`, `app-manager/services/deploy/deploy_svc.go`, `app-manager/logging/logger_fields.go`, and `app-manager/models/models.go`. If you ever need to re-read app-manager, those five files cover ~95% of what's in this playbook.
