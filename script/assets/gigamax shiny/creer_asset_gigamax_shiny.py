import os
from PIL import Image

INPUT_DIR = "assets_a_traiter"
OUTPUT_DIR = "result_gigamax/"
GIGAMAX_LOGO_PATH = "gigamax_logo.png"
SHINY_LOGO_PATH = "shiny_logo.png"

LOGO_SCALE = 0.8
BACKGROUND_MODE = True
LOGO_OPACITY = 140


def is_allowed_file(filename: str) -> bool:
    return filename.lower().endswith(".png")


def resize_logo(base_img: Image.Image, logo: Image.Image):
    """Redimensionne et centre un logo."""
    w, h = base_img.size

    new_w = int(w * LOGO_SCALE)
    ratio = new_w / logo.width
    new_h = int(logo.height * ratio)

    logo_resized = logo.resize((new_w, new_h), Image.LANCZOS)

    lx = (w - new_w) // 2
    ly = (h - new_h) // 2

    return logo_resized, lx, ly


def generate_image(pokemon_path: str, output_path: str,
                   gigamax_logo: Image.Image,
                   shiny_logo: Image.Image):

    pokemon = Image.open(pokemon_path).convert("RGBA")
    combined = Image.new("RGBA", pokemon.size, (0, 0, 0, 0))

    # --- GIGAMAX ---
    giga_resized, gx, gy = resize_logo(pokemon, gigamax_logo)

    if BACKGROUND_MODE:
        combined.alpha_composite(giga_resized, (gx, gy))
        combined.alpha_composite(pokemon, (0, 0))
    else:
        combined.alpha_composite(pokemon, (0, 0))
        combined.alpha_composite(giga_resized, (gx, gy))

    # --- SHINY (exact même logique que ton script dédié) ---
    shiny_resized, sx, sy = resize_logo(pokemon, shiny_logo)

    if BACKGROUND_MODE:
        combined.alpha_composite(shiny_resized, (sx, sy))
    else:
        combined.alpha_composite(shiny_resized, (sx, sy))

    combined.save(output_path, "PNG")


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    gigamax_logo = Image.open(GIGAMAX_LOGO_PATH).convert("RGBA")
    shiny_logo = Image.open(SHINY_LOGO_PATH).convert("RGBA")

    files = [
        f for f in os.listdir(INPUT_DIR)
        if os.path.isfile(os.path.join(INPUT_DIR, f)) and is_allowed_file(f)
    ]

    print(f"Fichiers détectés : {len(files)}")
    print("Génération des assets…\n")

    for filename in files:
        in_path = os.path.join(INPUT_DIR, filename)

        base, ext = os.path.splitext(filename)
        out_name = f"{base}_gigamax{ext}"
        out_path = os.path.join(OUTPUT_DIR, out_name)

        generate_image(in_path, out_path, gigamax_logo, shiny_logo)

        print(f"✔ {filename} → {out_name}")

    print("\nTerminé ! Les images sont dans :", OUTPUT_DIR)


if __name__ == "__main__":
    main()