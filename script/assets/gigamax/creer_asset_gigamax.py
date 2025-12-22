import os
from PIL import Image

INPUT_DIR = "../assets manquants/gigamax shiny/"
OUTPUT_DIR = "result_gigamax/"
LOGO_PATH = "gigamax_logo.png"

LOGO_SCALE = 0.8
BACKGROUND_MODE = True
LOGO_OPACITY = 140


def is_allowed_file(filename: str) -> bool:
    """Retourne True si l'image doit être traitée (contient GIGANTAMAX)."""
    if not filename.lower().endswith(".png"):
        return False

    # On traite uniquement les fichiers contenant 'GIGANTAMAX'
    return "gigantamax" in filename.lower()


def generate_gigamax(pokemon_path: str, output_path: str, logo: Image.Image):
    """Génère l'image Gigamax pour un fichier donné."""
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
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)

    logo = Image.open(LOGO_PATH).convert("RGBA")

    files = [f for f in os.listdir(INPUT_DIR)]

    print(f"Fichiers GIGANTAMAX détectés : {len(files)}")
    print("Génération des assets Gigamax…\n")

    for filename in files:
        in_path = os.path.join(INPUT_DIR, filename)

        # Nom de sortie ex : pm1.GIGANTAMAX.icon.png → pm1.GIGANTAMAX.icon_gigamax.png
        base, ext = os.path.splitext(filename)
        out_name = f"{base}_gigamax{ext}"
        out_path = os.path.join(OUTPUT_DIR, out_name)

        generate_gigamax(in_path, out_path, logo)

        print(f"✔ {filename} → {out_name}")

    print("\nTerminé ! Les images Gigamax sont dans :", OUTPUT_DIR)


if __name__ == "__main__":
    main()
