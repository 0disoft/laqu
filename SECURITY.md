# Security Policy

## Supported Versions

Security fixes are provided for the latest published release of `@0disoft/laqu`. Upgrade to the
latest release before reporting an issue that may already be fixed.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/0disoft/laqu/security/advisories/new>

Include the affected version, platform, terminal or stream configuration, impact, reproduction
steps, and any suggested mitigation. Do not open a public issue for a vulnerability that has not
been disclosed or fixed.

A confirmed report will be assessed for impact, a fix and release will be prepared when needed, and
disclosure timing will be coordinated with the reporter. If the private reporting form is
unavailable, avoid publishing exploit details and open a minimal issue asking the maintainer to
enable a private contact path.

## Scope

Examples of relevant reports include:

- terminal escape or control-sequence injection that bypasses Laqu's sanitization boundary;
- output corruption that writes status data to caller-owned stdout unexpectedly;
- unbounded memory or output growth reachable through documented APIs;
- process lifecycle behavior that unexpectedly intercepts or changes application termination;
- package or release integrity problems affecting the published artifact.

General bugs, feature requests, and unsupported-environment failures belong in the public issue
tracker.
