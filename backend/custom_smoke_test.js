const path = require('path');
const dotenv = require('dotenv');
const { ethers } = require('ethers');
const fetch = require('node-fetch');

// Load env
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
process.env.NODE_ENV = 'production';
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '00000000000000000000000000000000';

const db = require('./src/db');
const { signToken } = require('./src/middleware/auth');
const { buildApplicationMessage, buildDeliveryMessage } = require('./src/routes/publicJobs');

const BASE_URL = 'https://backend-production-597c.up.railway.app';

async function runTest() {
  const report = {
    scenario: "two_agent_reject_flow",
    steps: [],
    success: false
  };

  const step = async (label, fn) => {
    const start = Date.now();
    try {
      const result = await fn();
      report.steps.push({ label, ok: true, durationMs: Date.now() - start, detail: result });
      return result;
    } catch (err) {
      report.steps.push({ label, ok: false, durationMs: Date.now() - start, error: err.message });
      throw err;
    }
  };

  try {
    // 1. Create employer smoke user A and agent A
    const agentA = await step('create_agent_a', async () => {
      const wallet = ethers.Wallet.createRandom();
      const userRes = await db.query(
        "INSERT INTO users (owner_address) VALUES ($1) RETURNING id",
        [wallet.address.toLowerCase()]
      );
      const userId = userRes.rows[0].id;
      const agentRes = await db.query(
        "INSERT INTO agents (name, user_id, status) VALUES ($1, $2, $3) RETURNING id",
        ['Smoke Agent A', userId, 'active']
      );
      const agentId = agentRes.rows[0].id;
      // Fixed signToken signature (it expects two arguments: userId, ownerAddress)
      const token = signToken(userId, wallet.address.toLowerCase());
      return { agentId, userId, wallet, token };
    });

    // 2. Create second smoke user B and agent B
    const agentB = await step('create_agent_b', async () => {
      const wallet = ethers.Wallet.createRandom();
      const userRes = await db.query(
        "INSERT INTO users (owner_address) VALUES ($1) RETURNING id",
        [wallet.address.toLowerCase()]
      );
      const userId = userRes.rows[0].id;
      const agentRes = await db.query(
        "INSERT INTO agents (name, user_id, status) VALUES ($1, $2, $3) RETURNING id",
        ['Smoke Agent B', userId, 'active']
      );
      const agentId = agentRes.rows[0].id;
      return { agentId, userId, wallet };
    });

    // 3. Agent A creates a job
    const job = await step('agent_a_creates_job', async () => {
      const jobData = {
        title: 'Smoke Test Job (Reject Flow)',
        description: 'Testing the rejection flow',
        budget: '50',
        acceptingApplications: true
      };
      const res = await fetch(`${BASE_URL}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentA.token}`
        },
        body: JSON.stringify(jobData)
      });
      if (!res.ok) throw new Error(`Failed to create job: ${res.status} ${await res.text()}`);
      return await res.json();
    });

    // 4. Confirm public board exposes it
    await step('public_board_lists_job', async () => {
      const res = await fetch(`${BASE_URL}/jobs/public`);
      if (!res.ok) throw new Error(`Failed to fetch public board: ${res.status}`);
      const board = await res.json();
      const found = board.find(j => j.id === job.id);
      if (!found) throw new Error('Job not found on public board');
      if (found.boardMode !== 'open_applications') throw new Error(`Wrong boardMode: ${found.boardMode}`);
      return { boardMode: found.boardMode };
    });

    // 5. Agent B applies
    await step('agent_b_applies', async () => {
      const message = buildApplicationMessage(job.id, agentB.wallet.address.toLowerCase());
      const signature = await agentB.wallet.signMessage(message);
      const res = await fetch(`${BASE_URL}/jobs/${job.id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerAddress: agentB.wallet.address.toLowerCase(),
          signature
        })
      });
      if (!res.ok) throw new Error(`Failed to apply: ${res.status} ${await res.text()}`);
      return await res.json();
    });

    // 6. Confirm employer A sees application
    await step('agent_a_sees_application', async () => {
      const res = await fetch(`${BASE_URL}/jobs/${job.id}`, {
        headers: { 'Authorization': `Bearer ${agentA.token}` }
      });
      const data = await res.json();
      if (!data.applications || !data.applications.some(a => a.provider_address === agentB.wallet.address.toLowerCase())) {
        throw new Error('Agent B application not found');
      }
      return { applicationCount: data.applications.length };
    });

    // 7. Employer A assigns provider to B
    await step('agent_a_assigns_b', async () => {
      const res = await fetch(`${BASE_URL}/jobs/${job.id}/assign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${agentA.token}`
        },
        body: JSON.stringify({ providerAddress: agentB.wallet.address.toLowerCase() })
      });
      if (!res.ok) throw new Error(`Failed to assign: ${res.status} ${await res.text()}`);
      return await res.json();
    });

    // 8. Agent B delivers wrong hash
    const deliverableHash = '0x' + 'f'.repeat(64);
    await step('agent_b_delivers_wrong_hash', async () => {
      const message = buildDeliveryMessage(job.id, deliverableHash);
      const signature = await agentB.wallet.signMessage(message);
      const res = await fetch(`${BASE_URL}/jobs/${job.id}/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerAddress: agentB.wallet.address.toLowerCase(),
          deliverableHash,
          signature
        })
      });
      if (!res.ok) throw new Error(`Failed to deliver: ${res.status} ${await res.text()}`);
      return await res.json();
    });

    // 9. Employer A rejects (cancel)
    await step('agent_a_rejects_job', async () => {
      const res = await fetch(`${BASE_URL}/jobs/${job.id}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${agentA.token}` }
      });
      if (!res.ok) throw new Error(`Failed to cancel: ${res.status} ${await res.text()}`);
      return await res.json();
    });

    // 10. Verify cancelled state
    await step('verify_cancelled_state', async () => {
      const res = await fetch(`${BASE_URL}/jobs/${job.id}`, {
        headers: { 'Authorization': `Bearer ${agentA.token}` }
      });
      const data = await res.json();
      if (data.status !== 'cancelled') throw new Error(`Expected cancelled, got ${data.status}`);
      return { status: data.status };
    });

    report.success = true;
  } catch (err) {
    console.error('Test failed at some step');
  } finally {
    // Cleanup
    await step('cleanup', async () => {
      const userIds = report.steps
        .filter(s => s.ok && (s.label === 'create_agent_a' || s.label === 'create_agent_b'))
        .map(s => s.detail.userId);
      
      const jobIds = report.steps
        .filter(s => s.ok && s.label === 'agent_a_creates_job')
        .map(s => s.detail.id);

      if (jobIds.length) {
        await db.query("DELETE FROM audit_logs WHERE job_id = ANY($1)", [jobIds]);
        await db.query("DELETE FROM applications WHERE job_id = ANY($1)", [jobIds]);
        await db.query("DELETE FROM jobs WHERE id = ANY($1)", [jobIds]);
      }
      if (userIds.length) {
        // This will cascade delete agents
        await db.query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
      }
      return { prunedUsers: userIds.length, prunedJobs: jobIds.length };
    });
    
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.success ? 0 : 1);
  }
}

runTest();
