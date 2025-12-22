import os
from PIL import Image

INPUT_DIR = "../shiny/result/"
OUTPUT_DIR = "result/"
LOGO_PATH = "shadow_logo.png"

LOGO_SCALE = 0.8
BACKGROUND_MODE = False  # logo PAR-DESSUS

# suffixes à exclure
EXCLUDED_SUFFIXES = (
    "portrait.png",
    "GIGANTAMAX.png",
    "MEGA.icon.png",
    "MEGA.s.icon.png",
)

def is_allowed_file(filename: str) -> bool:
    """Retourne True si l'image doit être traitée."""
    if not filename.lower().endswith(".png"):
        return False
    for suffix in EXCLUDED_SUFFIXES:
        if filename.endswith(suffix):
            return False
    return True

def generate_shadow(pokemon_path: str, output_path: str, logo: Image.Image):
    """Génère l'image Shadow pour un fichier donné."""
    pokemon = Image.open(pokemon_path).convert("RGBA")

    w, h = pokemon.size

    # Redimension du logo (proportion identique à Dynamax)
    new_w = int(w * LOGO_SCALE)
    ratio = new_w / logo.width
    new_h = int(logo.height * ratio)
    logo_resized = logo.resize((new_w, new_h), Image.LANCZOS)

    # Position centrée
    lx = (w - new_w) // 2
    ly = (h - new_h) // 2

    # Image finale transparente
    combined = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    if BACKGROUND_MODE:
        combined.alpha_composite(logo_resized, (lx, ly))
        combined.alpha_composite(pokemon, (0, 0))
    else:
        combined.alpha_composite(pokemon, (0, 0))
        combined.alpha_composite(logo_resized, (lx, ly))

    combined.save(output_path, "PNG")


def main():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)

    # Charger le logo Shadow une seule fois
    logo = Image.open(LOGO_PATH).convert("RGBA")

    files = [f for f in os.listdir(INPUT_DIR) if is_allowed_file(f)]

    print(f"Fichiers détectés : {len(files)}")
    print("Génération des assets Shadow…\n")

    for filename in files:
        in_path = os.path.join(INPUT_DIR, filename)

        # Nom de fichier de sortie
        base, ext = os.path.splitext(filename)
        out_name = f"{base}_shadow{ext}"
        out_path = os.path.join(OUTPUT_DIR, out_name)

        generate_shadow(in_path, out_path, logo)

        print(f"✔ {filename} → {out_name}")

    print("\nTerminé ! Les images Shadow sont dans :", OUTPUT_DIR)

if __name__ == "__main__":
    main()
