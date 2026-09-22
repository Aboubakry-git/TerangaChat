#!/bin/bash

# Nom du fichier de destination
fichier_destination="fusion.txt"

# Vérifie si le fichier de destination existe, si oui, on le supprime
if [ -f "$fichier_destination" ]; then
    rm "$fichier_destination"
fi

# Fonction récursive pour parcourir les répertoires
parcourir_repertoire() {
    local repertoire="$1"
    
    # Pour chaque élément dans le répertoire
    for f in "$repertoire"/*; do
        # Vérifie si c'est un fichier
        if [ -f "$f" ]; then
            # Ajoute le nom du fichier comme séparateur
            echo "===== $f =====" >> "$fichier_destination"
            # Ajoute le chemin relatif
            echo "$f" >> "$fichier_destination"
            # Ajoute le contenu du fichier
            cat "$f" >> "$fichier_destination"
            # Ajoute deux lignes vides entre les fichiers
            echo -e "\n\n" >> "$fichier_destination"
        # Si c'est un répertoire, on le parcourt récursivement
        elif [ -d "$f" ]; then
            parcourir_repertoire "$f"
        fi
    done
}

# Démarrer le parcours à partir du répertoire courant
parcourir_repertoire "."

echo "Fusion des fichiers terminée. Résultat dans $fichier_destination"
