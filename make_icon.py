"""
Generate a sleek, modern, multi-size Windows icon (pressdf.ico) for PressDF.
Supersampled at 1024x1024 and downsampled to 256, 128, 64, 48, 32, 16.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def create_pressdf_icon(output_path: Path) -> None:
    # 1024x1024 canvas for crisp anti-aliasing
    size = 1024
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Outer rounded container (Squircle)
    margin = 48
    corner_radius = 210
    
    # Gradient background simulation
    # Deep obsidian / space slate background #0F172A -> #1E293B
    bg_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg_img)
    bg_draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=corner_radius,
        fill=(15, 23, 42, 255),
    )
    
    # Inner border / ambient highlight
    bg_draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=corner_radius,
        outline=(51, 65, 85, 255),
        width=12,
    )
    
    img = Image.alpha_composite(img, bg_img)
    draw = ImageDraw.Draw(img)

    # 2. PDF Document Page Shape
    # Page bounds
    p_left = 260
    p_top = 210
    p_right = 764
    p_bottom = 814
    fold_size = 140

    # Points for document with folded corner (top-right)
    # Top-left -> Top-right-before-fold -> Bottom-right-of-fold -> Bottom-right -> Bottom-left -> Top-left
    page_pts = [
        (p_left, p_top + 24),
        (p_left + 24, p_top),
        (p_right - fold_size, p_top),
        (p_right, p_top + fold_size),
        (p_right, p_bottom - 24),
        (p_right - 24, p_bottom),
        (p_left + 24, p_bottom),
        (p_left, p_bottom - 24),
    ]
    draw.polygon(page_pts, fill=(248, 250, 252, 255))

    # Folded flap
    flap_pts = [
        (p_right - fold_size, p_top),
        (p_right - fold_size, p_top + fold_size),
        (p_right, p_top + fold_size),
    ]
    draw.polygon(flap_pts, fill=(203, 213, 225, 255))
    # Small shadow under fold
    draw.line([(p_right - fold_size, p_top + fold_size), (p_right, p_top + fold_size)], fill=(148, 163, 184, 255), width=6)
    draw.line([(p_right - fold_size, p_top), (p_right - fold_size, p_top + fold_size)], fill=(148, 163, 184, 255), width=6)

    # 3. Ruby "PDF" Badge / Bar on Top
    badge_left = p_left + 54
    badge_top = p_top + 80
    badge_right = p_right - fold_size - 30
    badge_bottom = badge_top + 90
    draw.rounded_rectangle(
        [badge_left, badge_top, badge_right, badge_bottom],
        radius=16,
        fill=(225, 29, 72, 255),  # Crimson / Ruby
    )

    # Text "PDF" inside badge
    try:
        font = ImageFont.truetype("arialbd.ttf", 62)
    except Exception:
        font = ImageFont.load_default()
    
    # Center text in badge
    draw.text(
        ((badge_left + badge_right) / 2, (badge_top + badge_bottom) / 2 - 4),
        "PDF",
        fill=(255, 255, 255, 255),
        anchor="mm",
        font=font,
    )

    # 4. Stylized Compression Symbol in the center/lower half
    # Compression vise arrows (Top arrow pressing down, bottom arrow pressing up)
    # Emerald green accent (#10B981) + Cyan accent (#06B6D4)
    cx = 512
    cy = 530

    # Top downward arrow
    arrow_color_top = (16, 185, 129, 255)  # Emerald
    arrow_color_bottom = (6, 182, 212, 255)  # Cyan
    
    # Compression bar (middle horizontal line / press target)
    draw.rounded_rectangle([320, 508, 704, 532], radius=12, fill=(15, 23, 42, 230))
    
    # Downward arrow
    # Stem:
    draw.rounded_rectangle([cx - 24, 345, cx + 24, 465], radius=10, fill=arrow_color_top)
    # Head:
    draw.polygon([(cx - 70, 455), (cx + 70, 455), (cx, 500)], fill=arrow_color_top)

    # Upward arrow
    # Stem:
    draw.rounded_rectangle([cx - 24, 575, cx + 24, 695], radius=10, fill=arrow_color_bottom)
    # Head:
    draw.polygon([(cx - 70, 585), (cx + 70, 585), (cx, 540)], fill=arrow_color_bottom)

    # Subtle document bottom accent bar
    draw.rounded_rectangle([p_left + 60, 735, p_right - 60, 755], radius=10, fill=(226, 232, 240, 255))

    # Generate multi-size icon: 256, 128, 64, 48, 32, 16
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    icon_images = [img.resize(s, Image.Resampling.LANCZOS) for s in sizes]

    # Save .ico file with all embedded resolution layers
    output_path.parent.mkdir(parents=True, exist_ok=True)
    icon_images[0].save(
        output_path,
        format="ICO",
        sizes=sizes,
        append_images=icon_images[1:],
    )
    print(f"Icon successfully generated at: {output_path}")

    # Also save a 256x256 PNG for preview / static favicon
    png_path = output_path.with_suffix(".png")
    icon_images[0].save(png_path, format="PNG")
    print(f"PNG version saved at: {png_path}")


if __name__ == "__main__":
    out_ico = Path(__file__).resolve().parent / "pressdf.ico"
    create_pressdf_icon(out_ico)
