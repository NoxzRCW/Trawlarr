from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application configuration loaded from environment variables / .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # TMDB
    tmdb_api_key: str = ""
    tmdb_language: str = "fr-FR"
    tmdb_region: str = "FR"

    # Radarr
    radarr_url: str = "http://localhost:7878"
    radarr_api_key: str = ""

    # Defaults used when adding a movie to Radarr (resolved at runtime if empty)
    radarr_quality_profile_id: int | None = None
    radarr_root_folder: str | None = None
    radarr_monitor: bool = True
    radarr_search_on_add: bool = True
    radarr_minimum_availability: str = "released"  # announced | inCinemas | released

    # Sonarr (TV series)
    sonarr_url: str = "http://localhost:8989"
    sonarr_api_key: str = ""

    # Defaults used when adding a series to Sonarr (resolved at runtime if empty)
    sonarr_quality_profile_id: int | None = None
    sonarr_root_folder: str | None = None
    sonarr_monitor: bool = True
    sonarr_search_on_add: bool = True
    sonarr_season_folder: bool = True
    sonarr_series_type: str = "standard"  # standard | anime | daily

    app_title: str = "Media Search"

    @field_validator(
        "radarr_quality_profile_id",
        "radarr_root_folder",
        "sonarr_quality_profile_id",
        "sonarr_root_folder",
        mode="before",
    )
    @classmethod
    def _empty_to_none(cls, v: object) -> object:
        if isinstance(v, str) and v.strip() == "":
            return None
        return v


settings = Settings()
