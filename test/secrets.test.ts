import { describe, expect, it } from "vitest";
import { assertNoSecrets, findSecret, scrubSecrets } from "../src/secrets";

// Fake credentials are assembled at runtime so that secret scanners (and GitHub push
// protection) never see a literal token-shaped string in the repository.
const j = (...parts: string[]) => parts.join("");
const RANDOM = "Zx9Qm2Lp7Rt4Vb8Nc1Kd6Hs3Jf5Gw0Ty"; // 32 chars, base62 noise

const cases: { rule: string; secret: string; input: string; expected: string }[] = [
  {
    rule: "private-key",
    secret: j("-----BEGIN ", "RSA PRIVATE KEY-----\n", "MIIEowIBAAKCAQEA", RANDOM, "\n-----END RSA ", "PRIVATE KEY-----"),
    input: "",
    expected: "",
  },
  {
    rule: "private-key",
    // Cut off before its END line (e.g. by a pasted log): scrubbed to the end of the text.
    secret: j("-----BEGIN ", "OPENSSH PRIVATE KEY-----\n", "b3BlbnNzaC1rZXktdjEAAAAA", RANDOM),
    input: "",
    expected: "",
  },
  { rule: "jwt", secret: j("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_X"), input: "", expected: "" },
  { rule: "sk-key", secret: j("sk-", "proj-", RANDOM), input: "", expected: "" },
  { rule: "sk-key", secret: j("sk-", "ant-api03-", RANDOM), input: "", expected: "" },
  { rule: "github-token", secret: j("gh", "p_", RANDOM, "abcd"), input: "", expected: "" },
  { rule: "github-token", secret: j("gh", "o_", RANDOM, "abcd"), input: "", expected: "" },
  { rule: "github-token", secret: j("gh", "u_", RANDOM, "abcd"), input: "", expected: "" },
  { rule: "github-token", secret: j("gh", "s_", RANDOM, "abcd"), input: "", expected: "" },
  { rule: "github-token", secret: j("gh", "r_", RANDOM, "abcd"), input: "", expected: "" },
  { rule: "github-token", secret: j("github", "_pat_", "11ABCDEFG0", RANDOM, "_", RANDOM), input: "", expected: "" },
  { rule: "aws-access-key", secret: j("AKIA", "IOSFODNN7EXAMPLE"), input: "", expected: "" },
  { rule: "aws-access-key", secret: j("ASIA", "IOSFODNN7EXAMPLE"), input: "", expected: "" },
  { rule: "slack-token", secret: j("xox", "b-", "1234567890-", "abcdefABCDEF1234"), input: "", expected: "" },
  { rule: "slack-token", secret: j("xox", "p-", "1234567890-", "abcdefABCDEF1234"), input: "", expected: "" },
  { rule: "telegram-bot-token", secret: j("123456789", ":", "AAH", RANDOM), input: "", expected: "" },
  { rule: "hex-run", secret: "0123456789abcdef".repeat(4), input: "", expected: "" }, // 64 hex
  { rule: "hex-run", secret: "9f86d081884c7d659a2feaa0c55ad015", input: "", expected: "" }, // 32 hex
  { rule: "high-entropy-run", secret: j(RANDOM, "Ab3+Cd4/"), input: "", expected: "" },
].map((c) => ({ ...c, input: `before ${c.secret} after`, expected: "before [secret] after" }));

describe("scrubSecrets", () => {
  it.each(cases)("$rule: replaces the token with a placeholder", ({ rule, secret, input, expected }) => {
    expect(findSecret(input)).toBe(rule);
    // A private key block without an END line swallows the rest of the text.
    const out = scrubSecrets(input);
    if (secret.includes("PRIVATE KEY") && !secret.includes("-----END")) {
      expect(out).toBe("before [secret]");
    } else {
      expect(out).toBe(expected);
    }
    expect(out).not.toContain(secret);
  });

  it.each(cases)("$rule: scrubbed output passes the fail-closed re-check", ({ input }) => {
    const out = scrubSecrets(input);
    expect(findSecret(out)).toBeNull();
    expect(scrubSecrets(out)).toBe(out);
  });

  it("url-credentials: replaces only user:password, keeps scheme and host", () => {
    const input = j("DATABASE_URL=postgres://admin", ":", "hunter2@db.internal:5432/app");
    expect(findSecret(input)).toBe("url-credentials");
    expect(scrubSecrets(input)).toBe("DATABASE_URL=postgres://[secret]@db.internal:5432/app");
  });

  it("url-credentials: a password containing @ is scrubbed in full", () => {
    expect(scrubSecrets(j("https://bot", ":", "p@ss@example.com/x"))).toBe("https://[secret]@example.com/x");
  });

  it("bearer-token: keeps the word Bearer", () => {
    const input = j("curl -H 'Authorization: Bearer ", "abc123DEF456ghi789", "'");
    expect(findSecret(input)).toBe("bearer-token");
    expect(scrubSecrets(input)).toBe("curl -H 'Authorization: Bearer [secret]'");
  });

  it("scrubs every occurrence, not just the first", () => {
    const token = j("gh", "p_", RANDOM, "abcd");
    expect(scrubSecrets(`${token} and ${token}`)).toBe("[secret] and [secret]");
  });
});

describe("no false positives on ordinary commit text", () => {
  const benign = [
    "fix: retry the webhook (refs abc1234, 9f2e7d1c)",
    "Revert \"feat: add cache\"\n\nThis reverts commit 3f786850e387550fdab836ed7e6dc881de23001b.",
    "Merge pull request #42 from octocat/feat/ABC-1234-add-OAuth2-PKCE-flow-for-iOS-and-Android",
    "refactor: move src/components/UserProfile/AvatarUpload2x into packages/web/src/features/Checkout/PaymentStep3",
    "test: cover UserProfileAvatarUploadHandler2xRetina and HTTPRequestHandlerFactoryV2ImplementationTest",
    "chore: migration AddUserIdToOrders20260805Migration_Initial, request id 550e8400-e29b-41d4-a716-446655440000",
    "docs: see https://example.com/SomeOrg/MyProject-Backend2/blob/main/src/Foo.ts#L10-L20",
    "ci: clone via ssh://git@example.com/org/repo.git, dev server on http://localhost:8080/api",
    "feat: support Bearer authentication and bearer tokens in the API client",
    "deps: bump sk-learn-compatible-estimator-wrapper to 1.2.3",
    "feat(task-management-service): split task-list-for-dashboard-widgets",
    "perf: 2026-08-05T12:00:00Z build 1234567 took 12:30, 99.9% cache hits",
    "feat(i18n): русская локаль для отчёта — теперь всё по-русски",
    "fix: S3BucketPolicy/EC2InstanceRole/IAMPolicyV2/K8sPod wiring",
    "style: src/api/v1/UI/UX/i18n/l10n/A11y/K8s/S3/EC2/IAM/X",
  ];

  it.each(benign)("%s", (text) => {
    expect(findSecret(text)).toBeNull();
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe("assertNoSecrets", () => {
  it("passes a clean nested payload", () => {
    expect(() => assertNoSecrets({ a: ["feat: something", { b: "fine", n: 3, z: null }] })).not.toThrow();
  });

  it("throws with the rule and path, without echoing the secret", () => {
    const token = j("gh", "p_", RANDOM, "abcd");
    let error: Error | undefined;
    try {
      assertNoSecrets({ week: { prs: [{ title: "ok" }, { title: `leak ${token}` }] } });
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toMatch(/secret-like text \(github-token\) at \$\.week\.prs\[1\]\.title/);
    expect(error?.message).not.toContain(token);
  });
});
