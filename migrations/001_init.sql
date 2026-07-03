CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE segments (
  id            BIGSERIAL PRIMARY KEY,
  osm_way_id    BIGINT NOT NULL,
  part_index    INT NOT NULL,
  name          TEXT,
  surface_class TEXT NOT NULL CHECK (surface_class IN ('paved', 'unpaved', 'unknown')),
  gmina         TEXT,
  length_m      DOUBLE PRECISION NOT NULL,
  geom          geometry(LineString, 4326) NOT NULL,
  geom_m        geometry(LineString, 2180) NOT NULL,
  UNIQUE (osm_way_id, part_index)
);
CREATE INDEX segments_geom_idx ON segments USING GIST (geom);
CREATE INDEX segments_geom_m_idx ON segments USING GIST (geom_m);

CREATE TABLE gminas (
  name TEXT PRIMARY KEY,
  geom geometry(MultiPolygon, 4326) NOT NULL
);

CREATE TABLE rides (
  id                 BIGSERIAL PRIMARY KEY,
  strava_activity_id BIGINT UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  distance_m         DOUBLE PRECISION NOT NULL,
  elevation_m        DOUBLE PRECISION NOT NULL DEFAULT 0,
  unpaved_m          DOUBLE PRECISION NOT NULL DEFAULT 0,
  new_segments       INT NOT NULL DEFAULT 0,
  xp                 INT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'imported'
                     CHECK (status IN ('imported', 'skipped_no_gps', 'failed')),
  track              geometry(LineString, 4326)
);

CREATE TABLE claims (
  segment_id BIGINT PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
  ride_id    BIGINT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE strava_tokens (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL
);
