---
title: Connect to Remote VMs and Workspaces
description: How to configure Alice to execute commands and tools inside a remote SSH environment
tags: [ssh, remote, workspace, environments]
---

# Connect to Remote VMs and Workspaces

Alice supports executing all its core tools (terminal, file reading/writing, bash commands) inside a remote SSH environment instead of your local machine. This is managed by the `SSHEnvironment` backend.

## 1. SSH Authentication Requirement

> [!IMPORTANT]
> The SSH environment backend uses `BatchMode=yes`, which means it **does not support password authentication**. You must set up SSH key-based authentication to the remote VM first.

If you only have a password for the remote VM, you must first copy your local public key to the VM:
```bash
# Generate a key if you don't have one
ssh-keygen -t ed25519 -C "alice-agent" -f ~/.ssh/id_ed25519_lydia -N ""

# Copy it to the remote VM (you will be prompted for the password once)
ssh-copy-id -i ~/.ssh/id_ed25519_lydia.pub user@10.1.200.142
```

## 2. Configuring Alice

Once key-based authentication is working, you need to configure Alice to use the SSH environment. You can do this by setting environment variables or by updating the `config.yaml` file (located in `~/.alice/config.yaml` or `~/.alice/config.yaml`).

### Option A: config.yaml (Recommended)
Add the following to your config file:
```yaml
terminal:
  env: ssh
  ssh_host: "10.1.200.142"
  ssh_user: "username"
  ssh_port: 22
  ssh_key: "/home/user/.ssh/id_ed25519_lydia"
```

### Option B: Environment Variables
Alternatively, start Alice with these variables:
```bash
TERMINAL_ENV=ssh \
TERMINAL_SSH_HOST="10.1.200.142" \
TERMINAL_SSH_USER="username" \
TERMINAL_SSH_PORT="22" \
TERMINAL_SSH_KEY="/home/user/.ssh/id_ed25519_lydia" \
alice
```

## 3. What the SSH Backend Handles

Once configured, the SSH backend automatically handles:
- **Persistent Sessions**: It uses SSH `ControlMaster` multiplexing, meaning it opens one persistent socket to the VM and reuses it for all subsequent commands.
- **File Synchronization**: It automatically syncs required local assets (like skills or credentials) to the remote VM.
- **Process Management**: Commands are run in a PTY so you can interact with them.

If the connection drops, Alice will attempt to re-establish it on the next command.
