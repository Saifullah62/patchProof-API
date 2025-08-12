// swagger.js
// Serves Swagger UI for the PatchProof API using the openapi.yaml spec.
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const logger = require('./logger');

const openapiPath = path.join(__dirname, 'openapi.yaml');
let openapiSpec;

try {
  openapiSpec = YAML.load(openapiPath);
} catch (err) {
  logger.error('[Swagger] Failed to load openapi.yaml. API documentation will be unavailable.', err);
}

/**
 * Sets up the Swagger UI documentation endpoint.
 * This can be conditionally disabled in production via environment variables.
 * @param {import('express').Application} app The Express application instance.
 */
function setupSwagger(app) {
  // Allow disabling of docs in a production environment for security.
  if (process.env.ENABLE_SWAGGER_DOCS === 'false') {
    logger.warn('[Swagger] API documentation is disabled by environment configuration.');
    return;
  }

  if (!openapiSpec) {
    logger.warn('[Swagger] OpenAPI spec is not available, skipping UI setup.');
    return;
  }

  const options = {
    // You can customize the Swagger UI here if needed
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'PatchProof API Docs',
  };

  const docsPath = '/docs';
  app.use(docsPath, swaggerUi.serve, swaggerUi.setup(openapiSpec, options));
  logger.info(`[Swagger] API documentation available at ${docsPath}`);
}

module.exports = setupSwagger;