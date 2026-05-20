/*
  Payments checkout schema for token-based public QR flow.
  Safe to run multiple times.
*/

IF NOT EXISTS (
  SELECT 1
  FROM sys.objects
  WHERE object_id = OBJECT_ID(N'lm5k.payments') AND type = 'U'
)
BEGIN
  CREATE TABLE lm5k.payments (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    orderId INT NOT NULL,
    provider NVARCHAR(50) NOT NULL,
    providerPaymentId NVARCHAR(120) NULL,
    paymentToken NVARCHAR(120) NOT NULL,
    amount DECIMAL(18,2) NOT NULL,
    currency NVARCHAR(10) NOT NULL,
    commissionAmount DECIMAL(18,2) NOT NULL,
    netAmount DECIMAL(18,2) NOT NULL,
    checkoutUrl NVARCHAR(500) NOT NULL,
    qrCodeUrl NVARCHAR(1000) NULL,
    status NVARCHAR(30) NOT NULL,
    expiresAt DATETIME2 NOT NULL,
    paidAt DATETIME2 NULL,
    createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    deleted BIT NOT NULL DEFAULT 0
  );
END

IF COL_LENGTH('lm5k.payments', 'provider') IS NULL
  ALTER TABLE lm5k.payments ADD provider NVARCHAR(50) NOT NULL DEFAULT 'KLU_MOCK';
IF COL_LENGTH('lm5k.payments', 'providerPaymentId') IS NULL
  ALTER TABLE lm5k.payments ADD providerPaymentId NVARCHAR(120) NULL;
IF COL_LENGTH('lm5k.payments', 'paymentToken') IS NULL
  ALTER TABLE lm5k.payments ADD paymentToken NVARCHAR(120) NULL;
IF COL_LENGTH('lm5k.payments', 'amount') IS NULL
  ALTER TABLE lm5k.payments ADD amount DECIMAL(18,2) NOT NULL DEFAULT 0;
IF COL_LENGTH('lm5k.payments', 'currency') IS NULL
  ALTER TABLE lm5k.payments ADD currency NVARCHAR(10) NOT NULL DEFAULT 'MXN';
IF COL_LENGTH('lm5k.payments', 'commissionAmount') IS NULL
  ALTER TABLE lm5k.payments ADD commissionAmount DECIMAL(18,2) NOT NULL DEFAULT 0;
IF COL_LENGTH('lm5k.payments', 'netAmount') IS NULL
  ALTER TABLE lm5k.payments ADD netAmount DECIMAL(18,2) NOT NULL DEFAULT 0;
IF COL_LENGTH('lm5k.payments', 'checkoutUrl') IS NULL
  ALTER TABLE lm5k.payments ADD checkoutUrl NVARCHAR(500) NULL;
IF COL_LENGTH('lm5k.payments', 'qrCodeUrl') IS NULL
  ALTER TABLE lm5k.payments ADD qrCodeUrl NVARCHAR(1000) NULL;
IF COL_LENGTH('lm5k.payments', 'status') IS NULL
  ALTER TABLE lm5k.payments ADD status NVARCHAR(30) NOT NULL DEFAULT 'WAITING_PAYMENT';
IF COL_LENGTH('lm5k.payments', 'expiresAt') IS NULL
  ALTER TABLE lm5k.payments ADD expiresAt DATETIME2 NULL;
IF COL_LENGTH('lm5k.payments', 'paidAt') IS NULL
  ALTER TABLE lm5k.payments ADD paidAt DATETIME2 NULL;
IF COL_LENGTH('lm5k.payments', 'createdAt') IS NULL
  ALTER TABLE lm5k.payments ADD createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();
IF COL_LENGTH('lm5k.payments', 'updatedAt') IS NULL
  ALTER TABLE lm5k.payments ADD updatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();
IF COL_LENGTH('lm5k.payments', 'creationDate') IS NULL
  ALTER TABLE lm5k.payments ADD creationDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();
IF COL_LENGTH('lm5k.payments', 'lastModifiedDate') IS NULL
  ALTER TABLE lm5k.payments ADD lastModifiedDate DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'lm5k.payments') AND name = 'UX_payments_paymentToken'
)
BEGIN
  CREATE UNIQUE INDEX UX_payments_paymentToken
    ON lm5k.payments(paymentToken)
    WHERE paymentToken IS NOT NULL;
END

IF NOT EXISTS (
  SELECT 1
  FROM sys.objects
  WHERE object_id = OBJECT_ID(N'lm5k.payment_events') AND type = 'U'
)
BEGIN
  CREATE TABLE lm5k.payment_events (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    paymentId INT NOT NULL,
    eventType NVARCHAR(50) NOT NULL,
    providerStatus NVARCHAR(50) NULL,
    payload NVARCHAR(MAX) NULL,
    createdAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );

  CREATE INDEX IX_payment_events_paymentId
    ON lm5k.payment_events(paymentId, createdAt DESC);
END
