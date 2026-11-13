import pandas as pd
import logging

logger = logging.getLogger("GeoDataAI.QualityCheck")

def validate_fire_data(
    df: pd.DataFrame, *, raise_if_empty: bool = True
) -> pd.DataFrame:
    """Perform robust data quality checks on fire data"""
    initial_count = len(df)
    logger.info(f"Starting data quality checks on {initial_count} rows...")

    if df.empty:
        if raise_if_empty:
            raise ValueError("Critical Error: Provided dataframe is empty!")
        return df

    # 1. التأكد من أن الإحداثيات تقع ضمن النطاقات الجغرافية الصحيحة
    if "latitude" in df.columns and "longitude" in df.columns:
        valid_coords = (
            df["latitude"].between(-90, 90, inclusive="both") & 
            df["longitude"].between(-180, 180, inclusive="both")
        )
        df = df[valid_coords]

    # 2. فحص قيم السطوع والـ FRP (مع دعم مسميات MODIS و VIIRS المختلفة مثل bright_ti4)
    brightness_cols = [c for c in ["brightness", "bright_ti4", "bright_ti5"] if c in df.columns]
    for col in brightness_cols:
        df = df[df[col].isna() | (df[col] > 0)]

    if "frp" in df.columns:
        df = df[df["frp"].isna() | (df["frp"] >= 0)]

    # 3. إزالة الصفوف المكررة تماماً
    df = df.drop_duplicates()

    final_count = len(df)
    dropped_rows = initial_count - final_count
    
    logger.warning(f"Data Quality Check completed. Dropped {dropped_rows} invalid/corrupted rows. Remaining: {final_count} rows.")
    
    if final_count == 0 and raise_if_empty:
        raise ValueError("Critical Error: All rows failed data quality checks!")
        
    return df