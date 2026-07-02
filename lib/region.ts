export const REGION = {
  lat: Number(process.env.NEXT_PUBLIC_REGION_LAT ?? 54.41),
  lon: Number(process.env.NEXT_PUBLIC_REGION_LON ?? 16.86),
  radiusM: Number(process.env.REGION_RADIUS_M ?? 50000),
};
