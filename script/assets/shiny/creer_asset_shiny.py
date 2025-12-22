import os
from PIL import Image

ASSETS_DIR = "assets_a_traiter/"
OUTPUT_DIR = "result/"
LOGO_PATH = "shiny_logo.png"

LOGO_SCALE = 0.8
BACKGROUND_MODE = False
LOGO_OPACITY = 140

# suffixes à exclure (optionnel)
EXCLUDED_SUFFIXES = (
    "portrait.png",
)

def is_allowed_file(filename: str) -> bool:
    """Retourne True si le fichier est un PNG autorisé."""
    filename = filename.lower()

    # uniquement les PNG
    if not filename.endswith(".png"):
        return False

    # exclusions éventuelles
    for suffix in EXCLUDED_SUFFIXES:
        if filename.endswith(suffix):
            return False

    return True


def generate_dynamax(pokemon_path: str, output_path: str, logo: Image.Image):
    """Génère l'image avec logo."""
    pokemon = Image.open(pokemon_path).convert("RGBA")

    w, h = pokemon.size

    # Redimension du logo
    new_w = int(w * LOGO_SCALE)
    ratio = new_w / logo.width
    new_h = int(logo.height * ratio)
    logo_resized = logo.resize((new_w, new_h), Image.LANCZOS)

    # Position centrée
    lx = (w - new_w) // 2
    ly = (h - new_h) // 2

    combined = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    if BACKGROUND_MODE:
        combined.alpha_composite(logo_resized, (lx, ly))
        combined.alpha_composite(pokemon, (0, 0))
    else:
        combined.alpha_composite(pokemon, (0, 0))
        combined.alpha_composite(logo_resized, (lx, ly))

    combined.save(output_path, "PNG")


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    logo = Image.open(LOGO_PATH).convert("RGBA")

    files = [
        f for f in os.listdir(ASSETS_DIR)
        if os.path.isfile(os.path.join(ASSETS_DIR, f)) and is_allowed_file(f)
    ]

    print(f"Fichiers PNG détectés : {len(files)}")
    print("Génération des assets…\n")

    for filename in files:
        in_path = os.path.join(ASSETS_DIR, filename)

        base, ext = os.path.splitext(filename)
        out_name = f"{base}_shiny{ext}"
        out_path = os.path.join(OUTPUT_DIR, out_name)

        generate_dynamax(in_path, out_path, logo)

        print(f"✔ {filename} → {out_name}")

    print("\nTerminé ! Les images sont dans :", OUTPUT_DIR)


if __name__ == "__main__":
    main()
