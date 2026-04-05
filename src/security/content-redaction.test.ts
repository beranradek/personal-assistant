import { describe, it, expect } from "vitest";
import {
  CONSERVATIVE_PATTERNS,
  AGGRESSIVE_PATTERNS,
  redactString,
  createRedactor,
  redactDeep,
} from "./content-redaction.js";

const R = "[REDACTED]";

describe("content-redaction", () => {
  // ---------------------------------------------------------------------------
  // CONSERVATIVE_PATTERNS
  // ---------------------------------------------------------------------------

  describe("CONSERVATIVE_PATTERNS", () => {
    const redact = (text: string) => redactString(text, CONSERVATIVE_PATTERNS);

    describe("API keys (sk-/pk-)", () => {
      it("redacts sk- prefixed keys", () => {
        expect(redact("key is sk-abc123DEF456_ghi789-jklmno")).toBe(
          `key is ${R}`,
        );
      });

      it("redacts pk- prefixed keys", () => {
        expect(redact("pk-abcdefghijklmnopqrstu")).toBe(R);
      });

      it("does not redact short sk- strings", () => {
        expect(redact("sk-short")).toBe("sk-short");
      });
    });

    describe("AWS access keys", () => {
      it("redacts AKIA keys", () => {
        expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe(R);
      });

      it("does not redact partial AKIA", () => {
        expect(redact("AKIA12345")).toBe("AKIA12345");
      });
    });

    describe("Google API keys", () => {
      it("redacts AIza keys", () => {
        // AIza + exactly 35 characters
        expect(
          redact("AIzaSyA1234567890abcdefghijklmnopqrstuv"),
        ).toBe(R);
      });

      it("does not redact short AIza strings", () => {
        expect(redact("AIzaShort")).toBe("AIzaShort");
      });
    });

    describe("Bearer tokens", () => {
      it("redacts Bearer token", () => {
        expect(redact("Authorization: Bearer eyJhbGciOi")).toBe(
          `Authorization: ${R}`,
        );
      });

      it("does not redact the word bearer alone", () => {
        expect(redact("The bearer of bad news")).toBe(
          "The bearer of bad news",
        );
      });
    });

    describe("Google access tokens", () => {
      it("redacts ya29. tokens", () => {
        expect(redact("access ya29.a0AfH6SMA_example")).toBe(
          `access ${R}`,
        );
      });

      it("does not redact ya29 without dot", () => {
        expect(redact("ya29 is a number")).toBe("ya29 is a number");
      });
    });

    describe("Google refresh tokens", () => {
      it("redacts 1// tokens", () => {
        expect(redact("refresh: 1//0dx-example_token")).toBe(
          `refresh: ${R}`,
        );
      });

      it("does not redact 1/ (single slash)", () => {
        expect(redact("page 1/5")).toBe("page 1/5");
      });
    });

    describe("JWT tokens", () => {
      it("redacts JWT", () => {
        const jwt =
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456";
        expect(redact(jwt)).toBe(R);
      });

      it("does not redact eyJ prefix alone", () => {
        expect(redact("eyJhello")).toBe("eyJhello");
      });
    });

    describe("password/secret in key=value", () => {
      it("redacts password=value", () => {
        expect(redact("password=s3cret123")).toBe(R);
      });

      it("redacts secret: value", () => {
        expect(redact("secret: my-secret-val")).toBe(R);
      });

      it("redacts api_key=value", () => {
        expect(redact("api_key=abcdef")).toBe(R);
      });

      it("redacts apikey=value", () => {
        expect(redact("apikey=abcdef")).toBe(R);
      });

      it("redacts token=value", () => {
        expect(redact("token=abc123")).toBe(R);
      });

      it("redacts credential: value", () => {
        expect(redact("credential: xyz")).toBe(R);
      });

      it("does not redact 'password' without value", () => {
        expect(redact("enter your password")).toBe("enter your password");
      });
    });

    describe("credit card numbers", () => {
      it("redacts 16-digit card number", () => {
        expect(redact("card: 4111111111111111")).toBe(`card: ${R}`);
      });

      it("redacts card with dashes", () => {
        expect(redact("4111-1111-1111-1111")).toBe(R);
      });

      it("redacts card with spaces", () => {
        expect(redact("4111 1111 1111 1111")).toBe(R);
      });

      it("does not redact short digit sequences", () => {
        expect(redact("code: 123456")).toBe("code: 123456");
      });
    });

    describe("generic long tokens (40+ chars)", () => {
      it("redacts 40+ char alphanumeric string", () => {
        const longToken = "a".repeat(40);
        expect(redact(longToken)).toBe(R);
      });

      it("does not redact 39-char string", () => {
        const shortToken = "a".repeat(39);
        expect(redact(shortToken)).toBe(shortToken);
      });
    });

    it("does not redact normal text", () => {
      const text =
        "Hello, this is a normal message about deploying to production.";
      expect(redact(text)).toBe(text);
    });
  });

  // ---------------------------------------------------------------------------
  // AGGRESSIVE_PATTERNS (adds on top of conservative)
  // ---------------------------------------------------------------------------

  describe("AGGRESSIVE_PATTERNS", () => {
    const redact = (text: string) => redactString(text, AGGRESSIVE_PATTERNS);

    it("still catches conservative patterns", () => {
      expect(redact("sk-abcdefghij1234567890ab")).toBe(R);
    });

    describe("SSH/PGP private key blocks", () => {
      it("redacts private key block", () => {
        const key = `-----BEGIN RSA PRIVATE KEY-----
MIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJLA/t0x
-----END RSA PRIVATE KEY-----`;
        expect(redact(key)).toBe(R);
      });

      it("does not redact public key block", () => {
        const key = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhki
-----END PUBLIC KEY-----`;
        expect(redact(key)).toBe(key);
      });
    });

    describe("URLs with secret query params", () => {
      it("redacts token query param", () => {
        expect(redact("https://example.com/cb?token=abc123")).toContain(R);
      });

      it("redacts access_token param", () => {
        expect(
          redact("https://example.com/cb?access_token=secret"),
        ).toContain(R);
      });

      it("redacts api_key param", () => {
        expect(redact("https://example.com?foo=bar&api_key=xyz")).toContain(
          R,
        );
      });

      it("redacts apiKey param", () => {
        expect(redact("https://example.com?apiKey=xyz")).toContain(R);
      });

      it("does not redact non-secret query params", () => {
        const url = "https://example.com?page=1&limit=10";
        expect(redact(url)).toBe(url);
      });
    });

    describe("connection strings with credentials", () => {
      it("redacts postgres connection string", () => {
        expect(
          redact("postgres://user:pass@localhost:5432/db"),
        ).toBe(R);
      });

      it("redacts mongodb connection string", () => {
        expect(redact("mongodb://admin:pw@host/mydb")).toBe(R);
      });

      it("redacts redis connection string", () => {
        expect(redact("redis://default:secret@redis.io:6379")).toBe(R);
      });

      it("does not redact postgres:// without @", () => {
        expect(redact("postgres://localhost/db")).toBe(
          "postgres://localhost/db",
        );
      });
    });

    describe("Basic auth headers", () => {
      it("redacts Basic auth", () => {
        expect(redact("Authorization: Basic dXNlcjpwYXNz")).toBe(
          `Authorization: ${R}`,
        );
      });

      it("does not redact short Basic value", () => {
        expect(redact("Basic abc")).toBe("Basic abc");
      });
    });

    describe("Azure connection strings", () => {
      it("redacts AccountKey", () => {
        const result = redact("AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==");
        expect(result).toContain(R);
        expect(result).not.toContain("Eby8vdM02x");
      });

      it("redacts SharedAccessKey", () => {
        const result = redact("SharedAccessKey = abc123def456+/=");
        expect(result).toContain(R);
        expect(result).not.toContain("abc123def456");
      });
    });

    describe("GitHub tokens", () => {
      it("redacts ghp_ tokens", () => {
        const token = "ghp_" + "a".repeat(36);
        expect(redact(token)).toBe(R);
      });

      it("redacts ghs_ tokens", () => {
        const token = "ghs_" + "B1c2D3e4F5g6H7i8J9k0L1m2N3o4P5q6R7s8";
        expect(redact(token)).toBe(R);
      });

      it("does not redact short ghp_ strings", () => {
        expect(redact("ghp_short")).toBe("ghp_short");
      });
    });

    describe("Czech patterns", () => {
      it("redacts heslo=value", () => {
        expect(redact("heslo=tajne123")).toBe(R);
      });

      it("redacts dočasné heslo: value", () => {
        expect(redact("dočasné heslo: abc123")).toBe(R);
      });

      it("redacts nové heslo: value", () => {
        expect(redact("nové heslo: xyz")).toBe(R);
      });

      it("redacts vaše heslo: value", () => {
        expect(redact("vaše heslo: pass")).toBe(R);
      });

      it("redacts heslo je: value", () => {
        expect(redact("heslo je: secretval")).toBe(R);
      });

      it("redacts aktuální heslo=value", () => {
        expect(redact("aktuální heslo=old123")).toBe(R);
      });

      it("redacts PIN=value", () => {
        expect(redact("PIN=1234")).toBe(R);
      });

      it("redacts přístupový kód: value", () => {
        expect(redact("přístupový kód: 5678")).toBe(R);
      });

      it("redacts ověřovací kód: value", () => {
        expect(redact("ověřovací kód: 9012")).toBe(R);
      });

      it("redacts aktivační kód=value", () => {
        expect(redact("aktivační kód=ABCD")).toBe(R);
      });

      it("redacts API klíč: value", () => {
        expect(redact("API klíč: mykey123")).toBe(R);
      });

      it("redacts přístupový token=value", () => {
        const result = redact("přístupový token=tok123");
        expect(result).toContain(R);
        expect(result).not.toContain("tok123");
      });

      it("redacts autorizační token: value", () => {
        const result = redact("autorizační token: xyz");
        expect(result).toContain(R);
        expect(result).not.toContain("xyz");
      });

      it("redacts číslo karty: value", () => {
        const result = redact("číslo karty: 4111-1111-1111-1111");
        expect(result).toContain(R);
        expect(result).not.toContain("4111");
      });

      it("redacts číslo účtu: value", () => {
        expect(redact("číslo účtu: 1234567890/0800")).toBe(R);
      });

      it("redacts IBAN", () => {
        const result = redact("IBAN: CZ65 0800 0000 1920 0014 5399");
        expect(result).toContain(R);
        expect(result).not.toContain("0800 0000");
      });

      it("redacts IBAN without spaces", () => {
        const result = redact("CZ6508000000192000145399");
        expect(result).toContain(R);
        expect(result).not.toContain("0800");
      });

      it("does not redact normal Czech text", () => {
        const text =
          "Dobrý den, prosím o zaslání faktury na adresu kanceláře.";
        expect(redact(text)).toBe(text);
      });

      it("does not redact mention of heslo without value", () => {
        expect(redact("Zapomněl jsem heslo")).toBe(
          "Zapomněl jsem heslo",
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // createRedactor
  // ---------------------------------------------------------------------------

  describe("createRedactor", () => {
    it("returns identity function for empty patterns", () => {
      const redact = createRedactor([]);
      const text = "sk-abcdefghij1234567890ab password=secret";
      expect(redact(text)).toBe(text);
    });

    it("returns a working redactor with patterns", () => {
      const redact = createRedactor(CONSERVATIVE_PATTERNS);
      expect(redact("password=secret")).toBe(R);
    });

    it("is reusable across multiple calls (regex state reset)", () => {
      const redact = createRedactor(CONSERVATIVE_PATTERNS);
      const input = "password=secret";
      expect(redact(input)).toBe(R);
      expect(redact(input)).toBe(R);
      expect(redact(input)).toBe(R);
    });
  });

  // ---------------------------------------------------------------------------
  // redactDeep
  // ---------------------------------------------------------------------------

  describe("redactDeep", () => {
    it("redacts strings in nested objects", () => {
      const input = {
        outer: {
          inner: "password=secret",
          safe: "hello",
        },
      };
      const result = redactDeep(input, CONSERVATIVE_PATTERNS) as typeof input;
      expect(result.outer.inner).toBe(R);
      expect(result.outer.safe).toBe("hello");
    });

    it("redacts strings in arrays", () => {
      const input = ["password=secret", "normal text", "api_key=abc"];
      const result = redactDeep(input, CONSERVATIVE_PATTERNS) as string[];
      expect(result[0]).toBe(R);
      expect(result[1]).toBe("normal text");
      expect(result[2]).toBe(R);
    });

    it("passes through null", () => {
      expect(redactDeep(null, CONSERVATIVE_PATTERNS)).toBeNull();
    });

    it("passes through boolean", () => {
      expect(redactDeep(true, CONSERVATIVE_PATTERNS)).toBe(true);
      expect(redactDeep(false, CONSERVATIVE_PATTERNS)).toBe(false);
    });

    it("passes through number", () => {
      expect(redactDeep(42, CONSERVATIVE_PATTERNS)).toBe(42);
    });

    it("handles deeply nested mixed structures", () => {
      const input = {
        a: [1, "Bearer tok123", { b: null, c: "safe" }],
        d: true,
      };
      const result = redactDeep(input, CONSERVATIVE_PATTERNS) as any;
      expect(result.a[0]).toBe(1);
      expect(result.a[1]).toBe(R);
      expect(result.a[2].b).toBeNull();
      expect(result.a[2].c).toBe("safe");
      expect(result.d).toBe(true);
    });

    it("handles top-level string", () => {
      expect(redactDeep("password=abc", CONSERVATIVE_PATTERNS)).toBe(R);
    });
  });
});
