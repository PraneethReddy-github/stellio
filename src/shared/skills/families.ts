/**
 * Hand-written families of close substitutes (docs/07 §2): a JD that wants one member while the profile has
 * another gets an "Do you have this?" row instead of a flat "learn". Every member is a dictionary skill and a
 * family stays inside one dictionary category (a unit test checks both).
 */
export const SKILL_FAMILIES: readonly (readonly string[])[] = [
  ['PostgreSQL', 'MySQL', 'MariaDB', 'SQL Server', 'SQLite'],
  ['MongoDB', 'Couchbase'],
  ['Snowflake', 'Databricks'],
  ['BigQuery', 'Redshift'],
  ['Kafka', 'Apache Pulsar'],
  ['Airflow', 'Dagster', 'Prefect'],
  ['AWS', 'Azure', 'GCP'],
  ['React', 'Vue', 'Angular', 'Svelte'],
  ['Django', 'Flask', 'FastAPI'],
  ['Terraform', 'Pulumi'],
  ['Jenkins', 'GitHub Actions', 'GitLab CI', 'CircleCI'],
  ['Tableau', 'Power BI', 'Looker'],
  ['Elasticsearch', 'OpenSearch', 'Solr'],
  ['PyTorch', 'TensorFlow'],
  ['Ansible', 'Chef', 'Puppet'],
  ['Prometheus', 'Grafana', 'Datadog'],
  ['Spark', 'Flink'],
];
