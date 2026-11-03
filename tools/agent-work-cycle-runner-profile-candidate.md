# Temporary profile probe candidate

This candidate is prepared but not authorized by its existence. Root must approve the precise additional Windows effects before execution.

Source: tools/agent-work-cycle-runner-profile-probe.cc, derived from the original product probe, replacing profileless SID derivation with documented CreateAppContainerProfile and checked cleanup. The original probe-01 failure remains untouched.

Each invocation generates 128 random bits and creates a new AAW.C1.Analysis.Probe.<32 hex> profile, zero capabilities. An existing-name return is rejected; it is never opened or reused. Windows creates only that per-user/per-app profile under the current user's LocalAppData/Packages and its corresponding AppContainer mapping/storage. No service, account, system/user parent ACL, broad capability or firewall exception is requested.

Only product .local/agent-work-cycle-runner/probe-02/runtime, runtime/node.exe, input and output receive the exact new SID ACL. The runtime is a verified copy of existing product Node 24.20.0; source runtime ACLs remain unchanged. Model input is absent: the fixed script evaluates 19+23 and writes only output/result.json.

Atomic JOB_LIST, CREATE_SUSPENDED and AppContainer/SID/zero-capability/low-integrity/job-membership checks precede ResumeThread. The timeout is 10 seconds. Every success or exception path terminates the owned job, confirms zero active processes within five seconds, closes it, then deletes only the successfully created profile. Cleanup failure returns nonzero and reports the exact owned profile name for recovery; it does not claim success or delete an unowned profile. The normal result reports profileCreated/profileDeleted and actual exit/cleanup proof.

