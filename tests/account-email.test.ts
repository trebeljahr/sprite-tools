import { describe, expect, it } from "vitest";
import {
  projectSesMessage,
  sendProjectSesEmail,
  type ProjectSesConfig,
} from "@/lib/server/ses-email";

const config: ProjectSesConfig = {
  SES_PROJECT_ACCESS_KEY_ID: "fake-test-access-key",
  SES_PROJECT_SECRET_ACCESS_KEY: "fake-test-secret",
  SES_PROJECT_REGION: "eu-west-1",
  SES_PROJECT_IDENTITY_ARN: "arn:aws:ses:eu-west-1:123456789012:identity/mail.example.test",
  SES_PROJECT_TENANT: "test-tenant",
  SES_PROJECT_CONFIGURATION_SET: "test-config",
  SES_PROJECT_FROM_EMAIL: "noreply@mail.example.test",
  EMAIL_TEST_RECIPIENT: "test@example.test",
  isProduction: false,
  isTest: true,
};
const message = { to: "test@example.test", subject: "Test only", text: "Synthetic content" };

describe("isolated account email", () => {
  it("binds the request to the project sender and tenant", () => {
    const request = projectSesMessage(message, config);
    expect(request.FromEmailAddress).toBe(config.SES_PROJECT_FROM_EMAIL);
    expect(request.FromEmailAddressIdentityArn).toBe(config.SES_PROJECT_IDENTITY_ARN);
    expect(request.TenantName).toBe(config.SES_PROJECT_TENANT);
    expect(request.ConfigurationSetName).toBe(config.SES_PROJECT_CONFIGURATION_SET);
  });
  it("rejects another project's sender or a missing credential", () => {
    expect(() =>
      projectSesMessage(message, { ...config, SES_PROJECT_FROM_EMAIL: "other@elsewhere.test" }),
    ).toThrow();
    expect(() =>
      projectSesMessage(message, { ...config, SES_PROJECT_SECRET_ACCESS_KEY: "" }),
    ).toThrow();
  });
  it("rejects arbitrary recipients outside production", () => {
    expect(() => projectSesMessage({ ...message, to: "other@example.test" }, config)).toThrow();
  });
  it("does not initialize the SDK or send mail in test mode", async () => {
    await expect(sendProjectSesEmail(message, config)).resolves.toBeUndefined();
  });
});
