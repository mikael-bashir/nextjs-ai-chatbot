-- Revoke welcome bonus credits from users who have never purchased.
-- Paying users (type = 'purchase') are untouched.

UPDATE "UserCredits"
SET balance = 0, "updatedAt" = NOW()
WHERE "userId" NOT IN (
  SELECT DISTINCT "userId" FROM "CreditTransaction" WHERE type = 'purchase'
)
AND balance > 0;

DELETE FROM "CreditTransaction"
WHERE type = 'grant'
  AND description = 'Welcome bonus (£1 of free compute)'
  AND "userId" NOT IN (
    SELECT DISTINCT "userId" FROM "CreditTransaction" WHERE type = 'purchase'
  );
