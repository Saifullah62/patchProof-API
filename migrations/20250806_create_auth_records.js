// Migration for PatchProof auth_records table
exports.up = function(knex) {
  return knex.schema.createTable('auth_records', function(table) {
    table.string('txid').primary();
    table.json('record').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('auth_records');
};
